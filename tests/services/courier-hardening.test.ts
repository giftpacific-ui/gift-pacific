import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { applyCourierStatus, listCourierAttention } from "@/server/services/courier.service";
import { createSteadfastProvider } from "@/lib/courier/steadfast";
import { getCourierConfig } from "@/lib/courier/config";

let db: FakeDb;
const config = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "K", COURIER_API_SECRET: "S", COURIER_WEBHOOK_SECRET: "x".repeat(24) });
const provider = createSteadfastProvider(config, (async () => ({ kind: "network", message: "unused" })) as never);
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
const DAY = 86_400_000;

beforeEach(() => { db = freshDb(); });

const order = (id: string, o: Record<string, unknown> = {}) =>
  db.insert("order", { id, orderNumber: `AP-${id}`, phone: "0", status: "PROCESSING", courierProvider: "steadfast", courierConsignmentId: `C-${id}`, courierBookingStatus: "BOOKED", courierBookedAt: new Date(), ...o });

test("CRASH WINDOW: status recorded but order never advanced -> the next identical update heals it exactly once", async () => {
  // This is the state left behind if the process died after recording "delivered" but before moving the order.
  order("o1", { courierLastStatus: "delivered", status: "OUT_FOR_DELIVERY" });
  const healed = await admin(() => applyCourierStatus("o1", "delivered", provider));
  assert.equal(healed.applied, true);
  assert.equal(db.get("order", "o1").status, "DELIVERED");
  const again = await admin(() => applyCourierStatus("o1", "delivered", provider));
  assert.deepEqual(again, { applied: false, reason: "duplicate" });         // now a true duplicate: nothing pending
  assert.equal(db.get("order", "o1").status, "DELIVERED");
  assert.equal(db.rows("orderTrackingEvent").filter((e) => e.orderId === "o1").length, healed.applied ? (healed as { steps: unknown[] }).steps.length : 0);
});

test("a normal first update still works, and a replay with nothing pending is a no-op", async () => {
  order("o2", { status: "SHIPPED" });
  const first = await admin(() => applyCourierStatus("o2", "delivered", provider));
  assert.equal(first.applied, true);
  const events = db.rows("orderTrackingEvent").length;
  for (let i = 0; i < 3; i++) assert.deepEqual(await admin(() => applyCourierStatus("o2", "delivered", provider)), { applied: false, reason: "duplicate" });
  assert.equal(db.rows("orderTrackingEvent").length, events);               // replays add no history
});

test("replaying a stale courier status never reverses or re-opens a finished order", async () => {
  order("o3", { status: "CANCELLED", courierLastStatus: "in_review" });
  const r = await admin(() => applyCourierStatus("o3", "delivered", provider));
  assert.equal(r.applied, false);
  assert.equal(db.get("order", "o3").status, "CANCELLED");
});

test("an unknown order is reported as not found, not as a crash", async () => {
  assert.deepEqual(await admin(() => applyCourierStatus("ghost", "delivered", provider)), { applied: false, reason: "not_found" });
});

test("attention list: uncertain, stale-booking, failed and silent shipments are listed; healthy and finished orders are not", async () => {
  const now = new Date();
  order("uncertain", { courierBookingStatus: "UNCERTAIN" });
  order("stale", { courierBookingStatus: "BOOKING", courierBookingStartedAt: new Date(now.getTime() - 30 * 60_000) });
  order("fresh-claim", { courierBookingStatus: "BOOKING", courierBookingStartedAt: new Date(now.getTime() - 60_000) });   // still in progress: not stale
  order("failed", { courierBookingStatus: "FAILED", status: "CONFIRMED", courierLastError: "rejected" });
  order("silent", { courierLastEventAt: new Date(now.getTime() - 5 * DAY), status: "SHIPPED" });
  order("silent-never", { courierLastEventAt: null, courierBookedAt: new Date(now.getTime() - 5 * DAY), status: "SHIPPED" });
  order("recent", { courierLastEventAt: new Date(now.getTime() - 1 * DAY), status: "SHIPPED" });
  order("delivered", { courierLastEventAt: new Date(now.getTime() - 9 * DAY), status: "DELIVERED" });
  order("manual", { courierBookingStatus: "MANUAL" });
  order("untouched", { courierBookingStatus: "NOT_BOOKED", courierProvider: null, courierConsignmentId: null });
  const rows = await listCourierAttention(now);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.reason]));
  assert.deepEqual(byId, { uncertain: "uncertain", stale: "stale_booking", failed: "failed", silent: "silent_shipment", "silent-never": "silent_shipment" });
});

import { checkBookingEligibility } from "@/lib/courier/status";

test("self-shipped marketplace orders can be booked (COD amount 0 when paid, full total when unpaid); other payment methods still cannot", () => {
  const view = (o: Record<string, unknown>) => ({
    status: "CONFIRMED", paymentMethod: "MARKETPLACE", paymentStatus: "PAID", total: 1500, courierBookingStatus: "NOT_BOOKED", courierBookingStartedAt: null,
    recipient: { name: "Jo Doe", phone: "01711000000", address: "House 1, Road 2, Dhaka" }, ...o,
  }) as never;
  const now = new Date();
  assert.deepEqual(checkBookingEligibility(view({}), now), { ok: true, codAmount: 0, phone: "01711000000", address: "House 1, Road 2, Dhaka", name: "Jo Doe" });
  const unpaid = checkBookingEligibility(view({ paymentStatus: "UNPAID" }), now);
  assert.ok(unpaid.ok && unpaid.codAmount === 1500);
  assert.equal(checkBookingEligibility(view({ paymentMethod: "COD", paymentStatus: "UNPAID" }), now).ok, true);
  for (const method of ["STRIPE", "SSLCOMMERZ"]) {
    const r = checkBookingEligibility(view({ paymentMethod: method }), now);
    assert.ok(!r.ok && r.code === "not_cod", method);
  }
});
