import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, getOrderByNumberForCurrentUser, placeOrder } from "@/server/services/order.service";
import {
  applyCourierStatus, bookOrderWithCourier, getCourierPanel, handleCourierWebhook, reconcileCourier, refreshCourierStatus, saveManualCourier,
} from "@/server/services/courier.service";
import { getCourierConfig } from "@/lib/courier/config";
import { createSteadfastProvider } from "@/lib/courier/steadfast";
import type { CourierBookingResult, CourierProvider } from "@/lib/courier/types";
import { bookCourierAction, refreshCourierStatusAction } from "@/server/actions/admin-courier.actions";
import { updateOrderTrackingAction } from "@/server/actions/admin-order.actions";

let db: FakeDb;
const SECRET = "wh-secret-0123456789";
const config = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "KEY", COURIER_API_SECRET: "SEC", COURIER_WEBHOOK_SECRET: SECRET });

type Fake = CourierProvider & { bookCalls: number; results: CourierBookingResult[]; statusToReturn: string; gate?: Promise<void> };
function fakeProvider(results: CourierBookingResult[] = [{ ok: true, consignmentId: "C-1", trackingCode: "T-1", trackingUrl: null, providerStatus: "in_review" }]): Fake {
  const real = createSteadfastProvider(config, (async () => ({ kind: "network", message: "unused" })) as never);
  const p: Fake = {
    ...real, key: "steadfast", displayName: "Steadfast", bookCalls: 0, results, statusToReturn: "delivered",
    async book() { p.bookCalls++; if (p.gate) await p.gate; return p.results[Math.min(p.bookCalls - 1, p.results.length - 1)]; },
    async fetchStatus() { return { ok: true, status: p.statusToReturn }; },
  };
  return p;
}

beforeEach(() => { db = freshDb(); seedAdmins(db); seedCatalog(db); });
const stock = (id: string) => db.get("product", id).stock as number;

async function confirmedOrder(qty = 2, user = "cust") {
  await runAs({ sub: user }, () => addItemToCart({ productId: "p-standard", quantity: qty }));
  const o = await runAs({ sub: user }, () => placeOrder(emptyCheckout));
  await adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, TEST_ADMIN);
  return o;
}
const row = (id: string) => db.get("order", id);

test("booking success: stores consignment/tracking, leaves order status AND stock untouched", async () => {
  const o = await confirmedOrder();
  const stockBefore = stock("p-standard");
  const p = fakeProvider();
  const r = await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  assert.deepEqual(r, { booked: true, consignmentId: "C-1" });
  const saved = row(o.id);
  assert.equal(saved.courierBookingStatus, "BOOKED");
  assert.equal(saved.courierConsignmentId, "C-1");
  assert.equal(saved.trackingNumber, "T-1");
  assert.equal(saved.courierName, "Steadfast");
  assert.ok(saved.courierBookedAt instanceof Date);
  assert.equal(saved.status, "CONFIRMED"); // booking is NOT shipping and NOT delivery
  assert.equal(stock("p-standard"), stockBefore);
  assert.ok(db.rows("orderItem").every((i) => i.stockRestoredAt === null));
});

test("repeated / concurrent clicks create exactly ONE consignment", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider();
  let release!: () => void;
  p.gate = new Promise<void>((r) => (release = r)); // hold the first call "in flight"
  const attempts = Promise.allSettled(Array.from({ length: 6 }, () => bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config })));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const results = await attempts;
  assert.equal(p.bookCalls, 1);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  // and a later click after success is refused too
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config }), /already booked/i);
  assert.equal(p.bookCalls, 1);
});

test("definite rejection → FAILED (retry allowed); stock and status untouched; error stored admin-side only", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "rejected", message: "invalid phone" }, { ok: true, consignmentId: "C-2", trackingCode: null, trackingUrl: "https://t.example/C-2", providerStatus: null }]);
  const first = await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  assert.equal(first.booked, false);
  assert.equal(row(o.id).courierBookingStatus, "FAILED");
  assert.match(row(o.id).courierLastError, /invalid phone/);
  assert.equal(row(o.id).status, "CONFIRMED");
  assert.equal(stock("p-standard"), 3);
  const second = await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  assert.equal(second.booked, true);
  assert.equal(row(o.id).trackingNumber, "C-2"); // falls back to consignment id
  assert.equal(row(o.id).trackingUrl, "https://t.example/C-2");
  assert.equal(row(o.id).courierLastError, null);
});

test("uncertain outcome (timeout/5xx) → UNCERTAIN: retry is blocked until the admin confirms", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "no answer" }, { ok: true, consignmentId: "C-3", trackingCode: "T-3", trackingUrl: null, providerStatus: null }]);
  const first = await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  assert.equal(first.booked, false);
  assert.match((first as { message: string }).message, /check the courier portal/i);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config }), /confirm to retry|check the courier portal/i);
  assert.equal(p.bookCalls, 1);
  const panel = await getCourierPanel(o.id, { provider: p, config });
  assert.ok(panel!.needsConfirmation && panel!.canBook);
  assert.equal((await bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true }, { provider: p, config })).booked, true);
  assert.equal(p.bookCalls, 2);
});

test("a provider that throws is treated as uncertain, never as a crash or a success", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider();
  p.book = async () => { throw new Error("boom KEY"); };
  const r = await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  assert.equal(r.booked, false);
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  assert.ok(!String(row(o.id).courierLastError).includes("boom"));
});

test("eligibility is enforced: wrong status, no provider, COD only, manual entries", async () => {
  await runAs({ sub: "c1" }, () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const pending = await runAs({ sub: "c1" }, () => placeOrder(emptyCheckout));
  const p = fakeProvider();
  await assert.rejects(bookOrderWithCourier(pending.id, { actor: TEST_ADMIN }, { provider: p, config }), /Confirmed or Processing/);
  const o = await confirmedOrder(1, "c2");
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: null, config: getCourierConfig({}) }), /No courier provider/);
  assert.equal(p.bookCalls, 0);
  await saveManualCourier(o.id, { courierName: "Local Rider", trackingNumber: "L-1" }, TEST_ADMIN);
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config }), /entered manually/);
  assert.equal(p.bookCalls, 0);
  await assert.rejects(bookOrderWithCourier("missing", { actor: TEST_ADMIN }, { provider: p, config }), /not found/i);
});

test("booking sends the right customer / COD data and never exposes secrets in what is stored", async () => {
  const o = await confirmedOrder(2);
  const p = fakeProvider();
  let seen: unknown;
  const orig = p.book;
  p.book = async (req) => { seen = req; return orig.call(p, req); };
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  const req = seen as Record<string, unknown>;
  assert.equal(req.reference, o.orderNumber);
  assert.equal(req.recipientName, "Buyer One");
  assert.equal(req.recipientPhone, "01711000000");
  assert.equal(req.recipientAddress, "House 1, Road 2, Dhaka");
  assert.equal(req.codAmount, 3670);
  assert.match(String(req.itemDescription), /Clay Vase x2/);
  const stored = JSON.stringify(row(o.id));
  assert.ok(!stored.includes("KEY") && !stored.includes("SEC"));
});

test("webhook: rejects bad/missing auth, oversize and malformed bodies; 404 when unconfigured", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider();
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  const body = JSON.stringify({ notification_type: "delivery_status", consignment_id: "C-1", invoice: o.orderNumber, status: "delivered" });
  const deps = { provider: p, config };
  assert.equal((await handleCourierWebhook({ authorization: null, rawBody: body }, deps)).status, 401);
  assert.equal((await handleCourierWebhook({ authorization: "Bearer nope", rawBody: body }, deps)).status, 401);
  assert.equal((await handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: "x".repeat(70_000) }, deps)).status, 413);
  assert.equal((await handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: "{not json" }, deps)).status, 400);
  assert.equal((await handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: body }, { provider: null, config: getCourierConfig({}) })).status, 404);
  const noSecret = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "k", COURIER_API_SECRET: "s" });
  assert.equal((await handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: body }, { provider: p, config: noSecret })).status, 404);
  assert.equal(row(o.id).status, "CONFIRMED"); // nothing was applied by any rejected call
});

test("webhook delivered: walks the order forward legally; replays are idempotent; stock never moves", async () => {
  const o = await confirmedOrder(2);
  const p = fakeProvider();
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  const hook = (status: string, extra: object = {}) => handleCourierWebhook(
    { authorization: `Bearer ${SECRET}`, rawBody: JSON.stringify({ notification_type: "delivery_status", consignment_id: "C-1", invoice: o.orderNumber, status, ...extra }) },
    { provider: p, config },
  );
  const stockBefore = stock("p-standard");
  const r1 = await hook("delivered");
  assert.deepEqual(r1, { status: 200, body: { ok: true, note: "applied" } });
  assert.equal(row(o.id).status, "DELIVERED");
  const events = db.rows("orderTrackingEvent").map((e) => e.status);
  assert.deepEqual(events.slice(-3), ["PROCESSING", "SHIPPED", "DELIVERED"]); // CONFIRMED→…→DELIVERED, each step recorded
  const eventCount = db.rows("orderTrackingEvent").length;
  for (let i = 0; i < 3; i++) assert.equal((await hook("delivered")).body.note, "duplicate");
  assert.equal(db.rows("orderTrackingEvent").length, eventCount);
  // a late / out-of-order "pending" or "cancelled" can't drag a delivered order backwards
  await hook("in_review");
  await hook("cancelled");
  assert.equal(row(o.id).status, "DELIVERED");
  assert.equal(stock("p-standard"), stockBefore);
  assert.ok(db.rows("orderItem").every((i) => i.stockRestoredAt === null));
});

test("webhook concurrency: the same event delivered in parallel is applied once", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider();
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  const call = () => handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: JSON.stringify({ consignment_id: "C-1", status: "delivered" }) }, { provider: p, config });
  const results = await Promise.all(Array.from({ length: 5 }, call));
  assert.equal(results.filter((r) => r.body.note === "applied").length, 1);
  assert.equal(db.rows("orderTrackingEvent").filter((e) => e.status === "DELIVERED").length, 1);
});

test("courier return/cancel → FAILED_DELIVERY only when shipped; never CANCELLED, stock is not restored", async () => {
  const o = await confirmedOrder(2);
  const p = fakeProvider();
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  const stockHeld = stock("p-standard");
  await applyCourierStatus(o.id, "cancelled", p); // before pickup: ignored for order status
  assert.equal(row(o.id).status, "CONFIRMED");
  await adminUpdateOrderStatus(o.id, "PROCESSING", undefined, TEST_ADMIN);
  await adminUpdateOrderStatus(o.id, "SHIPPED", undefined, TEST_ADMIN);
  await applyCourierStatus(o.id, "hold", p);
  await applyCourierStatus(o.id, "cancelled", p);
  assert.equal(row(o.id).status, "FAILED_DELIVERY");
  assert.equal(stock("p-standard"), stockHeld); // restoring stock is never automatic after dispatch
  await adminUpdateOrderStatus(o.id, "CANCELLED", undefined, TEST_ADMIN);
  assert.equal(stock("p-standard"), stockHeld);  // the parcel is with the courier: cancelling does not guess it is back or sellable
  assert.equal(db.rows("orderItem")[0].stockReturnedQty, 0); // the 2 units are still tracked as out until an incident says otherwise
});

test("webhook for an unknown consignment is acknowledged without changing anything", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider();
  const r = await handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: JSON.stringify({ consignment_id: "NOPE", status: "delivered" }) }, { provider: p, config });
  assert.deepEqual(r, { status: 200, body: { ok: true, note: "unknown consignment" } });
  assert.equal(row(o.id).status, "CONFIRMED");
});

test("an UNCERTAIN booking self-heals when the courier's webhook echoes our order number", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "timeout" }]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  assert.equal(row(o.id).courierBookingStatus, "UNCERTAIN");
  const r = await handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: JSON.stringify({ consignment_id: "C-77", invoice: o.orderNumber, status: "in_review" }) }, { provider: p, config });
  assert.equal(r.status, 200);
  assert.equal(row(o.id).courierBookingStatus, "BOOKED");
  assert.equal(row(o.id).courierConsignmentId, "C-77");
  // but a webhook can't hijack an order that isn't waiting on a booking answer
  const o2 = await confirmedOrder(1, "other");
  await handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: JSON.stringify({ consignment_id: "C-88", invoice: o2.orderNumber, status: "delivered" }) }, { provider: p, config });
  assert.equal(row(o2.id).courierBookingStatus, "NOT_BOOKED");
  assert.equal(row(o2.id).status, "CONFIRMED");
});

test("manual refresh pulls the courier status through the same idempotent path", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider();
  await assert.rejects(refreshCourierStatus(o.id, TEST_ADMIN, { provider: p, config }), /no API-booked consignment/);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  p.statusToReturn = "delivered";
  const r = await refreshCourierStatus(o.id, TEST_ADMIN, { provider: p, config });
  assert.equal(r.applied, true);
  assert.equal(row(o.id).status, "DELIVERED");
  const again = await refreshCourierStatus(o.id, TEST_ADMIN, { provider: p, config });
  assert.deepEqual(again, { applied: false, reason: "duplicate" });
  await assert.rejects(refreshCourierStatus(o.id, TEST_ADMIN, { provider: { ...p, fetchStatus: undefined }, config }), /status/i);
});

test("manual fallback: works without any provider; validates URLs; blocked while API-booked", async () => {
  const o = await confirmedOrder();
  await saveManualCourier(o.id, { courierName: "Local Rider", trackingNumber: "L-1", trackingUrl: "https://track.example/1" }, TEST_ADMIN);
  assert.equal(row(o.id).courierBookingStatus, "MANUAL");
  assert.equal(row(o.id).trackingNumber, "L-1");
  await assert.rejects(saveManualCourier(o.id, { trackingUrl: "javascript:alert(1)" }, TEST_ADMIN), /http/);
  await saveManualCourier(o.id, {}, TEST_ADMIN); // clearing resets to NOT_BOOKED
  assert.equal(row(o.id).courierBookingStatus, "NOT_BOOKED");

  const o2 = await confirmedOrder(1, "u2");
  await bookOrderWithCourier(o2.id, { actor: TEST_ADMIN }, { provider: fakeProvider(), config });
  await assert.rejects(saveManualCourier(o2.id, { courierName: "Overwrite" }, TEST_ADMIN), /courier API/);
  assert.equal(row(o2.id).courierName, "Steadfast");
});

test("admin actions: admin-only, return safe results; manual tracking action goes through the guard", async () => {
  const o = await confirmedOrder();
  await assert.rejects(runAs(null, () => bookCourierAction(o.id)), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "cust" }, () => refreshCourierStatusAction(o.id)), /FORBIDDEN/);
  const res = await runAs("admin", () => bookCourierAction(o.id)); // no provider configured in this test env
  assert.equal(res.success, false);
  assert.ok(!/KEY|SEC|prisma/i.test(JSON.stringify(res)));
  assert.equal((await runAs("admin", () => updateOrderTrackingAction(o.id, { courierName: "Rider", trackingUrl: "javascript:x" }))).success, false);
  assert.equal((await runAs("admin", () => updateOrderTrackingAction(o.id, { courierName: "Rider", trackingNumber: "R1" }))).success, true);
});

test("customers see courier name / tracking only — never provider ids, state or errors", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider([{ ok: false, kind: "uncertain", message: "internal provider failure text" }, { ok: true, consignmentId: "C-9", trackingCode: "T-9", trackingUrl: null, providerStatus: "in_review" }]);
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN, confirmUncertain: true }, { provider: p, config });
  const view = await runAs({ sub: "cust" }, () => getOrderByNumberForCurrentUser(o.orderNumber));
  assert.equal(view!.trackingNumber, "T-9");
  assert.equal(view!.courierName, "Steadfast");
  const json = JSON.stringify(view);
  for (const w of ["C-9", "courierConsignmentId", "courierBookingStatus", "courierLastError", "courierLastStatus", "courierProvider", "internal provider failure"]) {
    assert.ok(!json.includes(w), `customer order leaked ${w}`);
  }
});

import { POST as webhookPOST } from "@/app/api/courier/webhook/route";

test("webhook size limit counts UTF-8 BYTES at the service layer too (multi-byte bodies)", async () => {
  const o = await confirmedOrder();
  const p = fakeProvider();
  await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config });
  const wide = JSON.stringify({ consignment_id: "C-1", status: "delivered", pad: "€".repeat(25_000) }); // ~75 KB, 25 K chars
  assert.ok(wide.length < 65_536 && Buffer.byteLength(wide) > 65_536);
  const r = await handleCourierWebhook({ authorization: `Bearer ${SECRET}`, rawBody: wide }, { provider: p, config });
  assert.equal(r.status, 413);
  assert.equal(row(o.id).status, "CONFIRMED"); // nothing applied
});

test("webhook ROUTE: bounded streaming read — oversize bodies get 413 without reaching the handler", async () => {
  const mk = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/courier/webhook", { method: "POST", body, headers });
  const huge = "€".repeat(25_000);
  const res = await webhookPOST(mk(huge));
  assert.equal(res.status, 413);
  // forged Content-Length: stream is still bounded
  const forged = await webhookPOST(mk(huge, { "content-length": "5" }));
  assert.ok([413, 400].includes(forged.status));
  // normal-size request reaches the handler (unconfigured provider in this env → 404, not 413)
  const ok = await webhookPOST(mk(JSON.stringify({ status: "delivered" })));
  assert.equal(ok.status, 404);
});

test("reconcile: polls in-flight booked orders; auto-booking is OFF unless asked, and never double-books", async () => {
  const a = await confirmedOrder(1, "c1");
  const b = await confirmedOrder(1, "c2");
  const p = fakeProvider();
  await bookOrderWithCourier(a.id, { actor: TEST_ADMIN }, { provider: p, config });
  await adminUpdateOrderStatus(a.id, "PROCESSING", undefined, TEST_ADMIN);
  p.statusToReturn = "delivered";
  // default: no auto-booking
  let r = await reconcileCourier({}, { provider: p, config });
  assert.deepEqual([r.polled, r.autoBooked], [1, 0]);
  assert.equal(row(b.id).courierBookingStatus, "NOT_BOOKED");
  assert.equal(row(a.id).status, "DELIVERED");
  // opt-in auto-booking books only the never-booked order, exactly once, even if run twice
  p.results = [{ ok: true, consignmentId: "C-B", trackingCode: "T-B", trackingUrl: null, providerStatus: "in_review" }];
  const before = p.bookCalls;
  r = await reconcileCourier({ autoBook: true }, { provider: p, config });
  await reconcileCourier({ autoBook: true }, { provider: p, config });
  assert.equal(p.bookCalls - before, 1);
  assert.equal(row(b.id).courierConsignmentId, "C-B");
});

test("reconcile with no provider configured does nothing (manual operation)", async () => {
  await confirmedOrder(1, "c3");
  assert.deepEqual(await reconcileCourier({ autoBook: true }, { provider: null, config }), { polled: 0, updated: 0, pollFailed: 0, autoBooked: 0, autoBookSkipped: 0 });
});
