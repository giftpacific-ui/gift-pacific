import { test } from "node:test";
import assert from "node:assert/strict";
import { ORDER_STATUSES, canTransition, shouldReleaseStock, type OrderStatusName } from "@/lib/order-transitions";
import {
  checkBookingEligibility, normalizeBdPhone, planOrderTransitions, recipientFromSnapshot,
  sanitizeProviderMessage, verifyBearerSecret, STALE_BOOKING_MS, type BookingOrderView,
} from "@/lib/courier/status";
import { buildTrackingUrl, getCourierConfig, isCourierUsable } from "@/lib/courier/config";
import type { CourierEvent } from "@/lib/courier/types";

const EVENTS: CourierEvent[] = ["PENDING", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RETURNED", "UNKNOWN"];

test("courier events can NEVER produce stock-moving statuses, and every step is a legal transition", () => {
  for (const current of ORDER_STATUSES) for (const event of EVENTS) {
    const steps = planOrderTransitions(current, event);
    let from: OrderStatusName = current;
    for (const step of steps) {
      assert.ok(!["CANCELLED", "REFUNDED", "REFUND_REQUESTED"].includes(step), `${current}+${event} -> ${step}`);
      assert.ok(canTransition(from, step), `${from} -> ${step} must be allowed`);
      assert.equal(shouldReleaseStock(from, step), false);
      from = step;
    }
    assert.ok(steps.length <= 3);
  }
});

test("typical delivery flow maps correctly; stale / duplicate events do nothing", () => {
  assert.deepEqual(planOrderTransitions("PROCESSING", "PICKED_UP"), ["SHIPPED"]);
  assert.deepEqual(planOrderTransitions("SHIPPED", "OUT_FOR_DELIVERY"), ["OUT_FOR_DELIVERY"]);
  assert.deepEqual(planOrderTransitions("OUT_FOR_DELIVERY", "DELIVERED"), ["DELIVERED"]);
  assert.deepEqual(planOrderTransitions("PROCESSING", "DELIVERED"), ["SHIPPED", "DELIVERED"]);
  assert.deepEqual(planOrderTransitions("SHIPPED", "DELIVERY_FAILED"), ["FAILED_DELIVERY"]);
  assert.deepEqual(planOrderTransitions("FAILED_DELIVERY", "DELIVERED"), ["OUT_FOR_DELIVERY", "DELIVERED"]);
  // stale / out of order
  assert.deepEqual(planOrderTransitions("DELIVERED", "PICKED_UP"), []);
  assert.deepEqual(planOrderTransitions("DELIVERED", "DELIVERY_FAILED"), []);
  assert.deepEqual(planOrderTransitions("DELIVERED", "DELIVERED"), []);
  assert.deepEqual(planOrderTransitions("OUT_FOR_DELIVERY", "PICKED_UP"), []);
  // a courier-side cancellation before pickup must not mark the order failed-delivery
  assert.deepEqual(planOrderTransitions("PROCESSING", "RETURNED"), []);
  // an un-confirmed order is never fast-forwarded through the admin steps (4 hops > cap)
  assert.deepEqual(planOrderTransitions("PENDING", "DELIVERED"), []);
  assert.deepEqual(planOrderTransitions("CONFIRMED", "DELIVERED"), ["PROCESSING", "SHIPPED", "DELIVERED"]);
  for (const terminal of ["CANCELLED", "REFUNDED"] as const) for (const e of EVENTS) assert.deepEqual(planOrderTransitions(terminal, e), []);
  assert.deepEqual(planOrderTransitions("PROCESSING", "PENDING"), []);
  assert.deepEqual(planOrderTransitions("PROCESSING", "UNKNOWN"), []);
});

const order = (o: Partial<BookingOrderView> = {}): BookingOrderView => ({
  status: "CONFIRMED", paymentMethod: "COD", paymentStatus: "UNPAID", total: 1870,
  courierBookingStatus: "NOT_BOOKED", courierBookingStartedAt: null,
  recipient: { name: "Buyer One", phone: "+8801711000000", address: "House 1, Dhaka" }, ...o,
});
const NOW = new Date("2026-10-10T10:00:00Z");

test("phone normalization (Bangladesh mobile numbers only)", () => {
  assert.equal(normalizeBdPhone("+8801711000000"), "01711000000");
  assert.equal(normalizeBdPhone("8801711-000 000"), "01711000000");
  assert.equal(normalizeBdPhone("01711000000"), "01711000000");
  for (const bad of ["", "12345", "+1 555 010 2020", "0171100000", "01011000000", "017110000000", "abc"]) assert.equal(normalizeBdPhone(bad), null, bad);
});

test("eligibility: status, COD, recipient and COD amount", () => {
  const ok = checkBookingEligibility(order(), NOW);
  assert.ok(ok.ok && ok.codAmount === 1870 && ok.phone === "01711000000");
  assert.ok(checkBookingEligibility(order({ status: "PROCESSING" }), NOW).ok);
  for (const status of ["PENDING", "SHIPPED", "DELIVERED", "CANCELLED", "FAILED_DELIVERY"] as const) {
    const r = checkBookingEligibility(order({ status }), NOW);
    assert.ok(!r.ok && r.code === "not_bookable_status", status);
  }
  assert.ok(!checkBookingEligibility(order({ paymentMethod: "STRIPE" }), NOW).ok);
  const paid = checkBookingEligibility(order({ paymentStatus: "PAID" }), NOW);
  assert.ok(paid.ok && paid.codAmount === 0); // nothing to collect
  for (const recipient of [null, { name: "", phone: "01711000000", address: "House 1" }, { name: "A B", phone: "123", address: "House 1" }, { name: "A B", phone: "01711000000", address: "x" }]) {
    const r = checkBookingEligibility(order({ recipient }), NOW);
    assert.ok(!r.ok && r.code === "bad_recipient");
  }
});

test("eligibility: duplicate / retry protection by booking state", () => {
  const code = (o: Partial<BookingOrderView>, confirm = false) => {
    const r = checkBookingEligibility(order(o), NOW, { confirmUncertain: confirm });
    return r.ok ? "ok" : r.code;
  };
  assert.equal(code({ courierBookingStatus: "BOOKED" }), "already_booked");
  assert.equal(code({ courierBookingStatus: "BOOKED" }, true), "already_booked"); // confirmation never overrides BOOKED
  assert.equal(code({ courierBookingStatus: "MANUAL" }), "manual");
  assert.equal(code({ courierBookingStatus: "FAILED" }), "ok"); // definite rejection: safe to retry
  assert.equal(code({ courierBookingStatus: "UNCERTAIN" }), "needs_confirmation");
  assert.equal(code({ courierBookingStatus: "UNCERTAIN" }, true), "ok");
  const fresh = new Date(NOW.getTime() - 60_000);
  const stale = new Date(NOW.getTime() - STALE_BOOKING_MS - 1000);
  assert.equal(code({ courierBookingStatus: "BOOKING", courierBookingStartedAt: fresh }, true), "in_progress");
  assert.equal(code({ courierBookingStatus: "BOOKING", courierBookingStartedAt: stale }), "needs_confirmation");
  assert.equal(code({ courierBookingStatus: "BOOKING", courierBookingStartedAt: stale }, true), "ok");
});

test("recipient from shipping snapshot (untrusted JSON)", () => {
  assert.deepEqual(recipientFromSnapshot({ fullName: " A B ", phone: "", line1: "H1", line2: "R2", city: "Dhaka" }, "01711000000"), { name: "A B", phone: "01711000000", address: "H1, R2, Dhaka" });
  assert.equal(recipientFromSnapshot(null, "x"), null);
  assert.equal(recipientFromSnapshot("str", "x"), null);
  assert.deepEqual(recipientFromSnapshot({ fullName: 5, line1: {} }, "p"), { name: "", phone: "p", address: "" });
});

test("sanitizing provider text masks secrets and control characters", () => {
  const out = sanitizeProviderMessage("bad key SECRET-KEY-123\n\u0000 and\tmore " + "x".repeat(500), ["SECRET-KEY-123", null, "ab"]);
  assert.ok(!out.includes("SECRET-KEY-123") && out.includes("***"));
  assert.ok(!/[\u0000-\u001f]/.test(out));
  assert.ok(out.length <= 300);
});

test("webhook bearer auth is exact and constant-time-safe", () => {
  assert.equal(verifyBearerSecret("Bearer s3cret-value", "s3cret-value"), true);
  assert.equal(verifyBearerSecret("bearer s3cret-value", "s3cret-value"), true);
  for (const bad of [null, undefined, "", "s3cret-value", "Bearer wrong", "Bearer ", "Basic s3cret-value", "Bearer s3cret-value-extra"]) {
    assert.equal(verifyBearerSecret(bad as never, "s3cret-value"), false, String(bad));
  }
  assert.equal(verifyBearerSecret("Bearer x", ""), false);
  assert.equal(verifyBearerSecret("Bearer x", undefined), false);
});

test("config: defaults to no provider; validates provider, credentials, https base URL, timeout", () => {
  assert.equal(isCourierUsable(getCourierConfig({})), false);
  assert.match(getCourierConfig({}).problem!, /No courier provider/);
  assert.match(getCourierConfig({ COURIER_PROVIDER: "fedex" }).problem!, /Unsupported/);
  assert.match(getCourierConfig({ COURIER_PROVIDER: "steadfast" }).problem!, /API_KEY/);
  const base = { COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "k", COURIER_API_SECRET: "s" };
  assert.equal(isCourierUsable(getCourierConfig(base)), true);
  assert.match(getCourierConfig({ ...base, COURIER_API_BASE_URL: "http://evil.example/api" }).problem!, /https/);
  assert.equal(isCourierUsable(getCourierConfig({ ...base, COURIER_API_BASE_URL: "https://sandbox.example/api" })), true);
  assert.equal(isCourierUsable(getCourierConfig({ ...base, COURIER_API_BASE_URL: "http://localhost:4010" })), true);
  assert.equal(getCourierConfig({ ...base, COURIER_TIMEOUT_MS: "99999999" }).timeoutMs, 10000);
  assert.equal(getCourierConfig({ ...base, COURIER_TIMEOUT_MS: "3000" }).timeoutMs, 3000);
  // tracking URL is never invented
  assert.equal(buildTrackingUrl(getCourierConfig(base), "ABC"), null);
  const t = getCourierConfig({ ...base, COURIER_TRACKING_URL_TEMPLATE: "https://track.example/t/{id}" });
  assert.equal(buildTrackingUrl(t, "A B/1"), "https://track.example/t/A%20B%2F1");
  assert.equal(getCourierConfig({ ...base, COURIER_TRACKING_URL_TEMPLATE: "javascript:{id}" }).trackingUrlTemplate, null);
});
