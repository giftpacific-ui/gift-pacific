/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { placeOrder } from "@/server/services/order.service";
import { getAdvancePanel, recheckOrderFraud, saveAdvanceSettings } from "@/server/services/advance.service";
import { resetFraudCheckStateForTests, setFraudCheckProviderForTests, setPhoneVerifiedForTests } from "@/server/services/fraud-check.service";
import { getAdvanceQuoteAction } from "@/server/actions/checkout.actions";
import { recheckFraudAction } from "@/server/actions/admin-advance.actions";

/**
 * Checkout enforcement and the admin recheck, end to end through the real services on the in-memory database.
 * The provider below is a STAND-IN that exists only in this test file. These tests prove OUR rules; they say nothing about any real provider,
 * and the in-memory database does not prove real locking or concurrency.
 */
let db: FakeDb;
let providerCalls: string[] = [];
const records = new Map<string, unknown>();
let mode: "ok" | "throw" = "ok";
const saved: Record<string, string | undefined> = {};
const ENV = ["FRAUD_CHECK_CACHE_SECONDS", "RATE_LIMIT_ENABLED"];

const policy = { enabled: true, zones: ["OUTSIDE_DHAKA"] as never, standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true, instructions: "Send to bKash 01XXXXXXXXX" };
const PHONE = "01711000001";

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.FRAUD_CHECK_CACHE_SECONDS = "0";
  process.env.RATE_LIMIT_ENABLED = "false";
  providerCalls = []; records.clear(); mode = "ok";
  resetFraudCheckStateForTests();
  setPhoneVerifiedForTests(undefined);                                   // the REAL default: no phone is verified
  setFraudCheckProviderForTests({
    key: "test-stand-in",
    check: async (phone) => { providerCalls.push(phone); if (mode === "throw") throw new Error("provider down"); return (records.get(phone) ?? { delivered: 0, cancelled: 0 }) as never; },
  });
  db = freshDb();
  seedAdmins(db);
  seedCatalog(db);
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer", role: "CUSTOMER", isActive: true });
  db.insert("user", { id: "adm-off", email: "off@staff.test", name: "Deactivated", role: "ADMIN", isActive: false });
  db.patch("product", "p-standard", { stock: 100 });
  await saveAdvanceSettings(policy as never, "a1");
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setFraudCheckProviderForTests(undefined);
  setPhoneVerifiedForTests(undefined);
  resetFraudCheckStateForTests();
});

let n = 0;
const place = (phone = PHONE, extra: Record<string, unknown> = {}) =>
  runAs(null, async () => {
    await addItemToCart({ productId: "p-standard", quantity: 1 });
    return placeOrder({ ...emptyCheckout, deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Sylhet", phone }, advanceMethod: "BKASH", advanceReference: `TXFRAUD${String(++n).padStart(5, "0")}`, ...extra } as never);
  });
const row = (id: string) => db.get("order", id);
const audits = (action: string) => db.rows("adminAuditEvent").filter((e) => e.action === action);

// ---- checkout: the server decides, whatever the provider says ---------------------------------------------------------------------------------
test("checkout: a perfect delivery record cannot lower the advance while the phone is unverified; the order stores real-provider evidence", async () => {
  records.set(PHONE, { delivered: 8, cancelled: 0, returned: 0, total: 8 });
  const o = await place();
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), r.trustReviewRequired], [50, 200, true]);          // delivered history earns nothing; the low tier still asks for review
  const fc = (r.trustSnapshot as any).fraudCheck;
  assert.deepEqual([fc.status, fc.source, fc.provider, fc.delivered, fc.cancelled, fc.total, fc.phoneVerified], ["ok", "provider", "test-stand-in", 8, 0, 8, false]);
  assert.equal(JSON.stringify(r.trustSnapshot).includes(PHONE), false);                                        // the phone number itself is not stored in the snapshot
  assert.equal(providerCalls.length, 1);
});

test("checkout: cancelled parcels lower trust but the advance stays the standard amount; the order is flagged for review", async () => {
  records.set(PHONE, { delivered: 3, cancelled: 2, returned: 1, total: 6 });
  const o = await place();
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), r.trustReviewRequired], [10, 200, true]);          // 50 - 2*20; delivered not credited; returned not scored
  assert.equal((r.trustSnapshot as any).fraudCheck.returned, 1);
});

test("checkout: provider failure, no provider, a bad phone and a switched-off check all use the safe fallback and never block the order", async () => {
  mode = "throw";
  const failed = await place();
  assert.deepEqual([row(failed.id).trustScore, Number(row(failed.id).advanceRequired)], [50, 200]);
  assert.deepEqual([(row(failed.id).trustSnapshot as any).fraudCheck.status, (row(failed.id).trustSnapshot as any).fraudCheck.reason, (row(failed.id).trustSnapshot as any).fraudCheck.source], ["unavailable", "error", "fallback"]);

  mode = "ok"; setFraudCheckProviderForTests(null);
  const none = await place();
  assert.deepEqual([(row(none.id).trustSnapshot as any).fraudCheck.reason, Number(row(none.id).advanceRequired)], ["no_provider", 200]);

  setFraudCheckProviderForTests({ key: "test-stand-in", check: async () => ({ delivered: 9, cancelled: 0 }) });
  const badPhone = await place("123456");
  assert.deepEqual([(row(badPhone.id).trustSnapshot as any).fraudCheck.reason, Number(row(badPhone.id).advanceRequired)], ["invalid_phone", 200]);
  process.env.FRAUD_CHECK_ENABLED = "false";
  try {
    const off = await place();
    assert.deepEqual([(row(off.id).trustSnapshot as any).fraudCheck.reason, Number(row(off.id).advanceRequired)], ["disabled", 200]);
  } finally { delete process.env.FRAUD_CHECK_ENABLED; }
});

test("checkout: a claim without a payment reference is still refused even when the provider is down (no bypass through failure)", async () => {
  mode = "throw";
  await assert.rejects(place(PHONE, { advanceReference: "" }), /advance of 200 is required/);
  assert.equal(db.rows("order").length, 0);
});

test("checkout: scores, statistics and amounts sent by the browser are ignored", async () => {
  records.set(PHONE, { delivered: 0, cancelled: 0 });
  const o = await place(PHONE, { trustScore: 100, trustTier: "full", fraudCheck: { status: "ok", delivered: 99, cancelled: 0 }, advanceRequired: 0, advancePaid: 5000, needsReview: false } as never);
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), Number(r.advancePaid)], [50, 200, 0]);
  assert.equal((r.trustSnapshot as any).fraudCheck.delivered, null);
});

test("checkout with a (simulated) verified phone: the same policy applies the reduced advance, so the verified path works once a mechanism exists", async () => {
  setPhoneVerifiedForTests(true);
  records.set(PHONE, { delivered: 5, cancelled: 0 });
  const o = await place();
  assert.deepEqual([row(o.id).trustScore, Number(row(o.id).advanceRequired), (row(o.id).trustSnapshot as any).fraudCheck.phoneVerified], [100, 100, true]);
});

test("checkout: repeated orders for one phone make ONE provider call while the cache is valid, and different phones do not share results", async () => {
  process.env.FRAUD_CHECK_CACHE_SECONDS = "600";
  records.set(PHONE, { delivered: 2, cancelled: 1 });
  const a = await place(); const b = await place();
  assert.equal(providerCalls.length, 1);
  assert.deepEqual([(row(a.id).trustSnapshot as any).fraudCheck.cached, (row(b.id).trustSnapshot as any).fraudCheck.cached], [false, true]);
  assert.equal(row(a.id).trustScore, row(b.id).trustScore);
  await place("01711000002");
  assert.equal(providerCalls.length, 2);
});

test("the checkout price preview never calls the provider (so it cannot be used to probe phone numbers) and shows the standard advance", async () => {
  const q = await getAdvanceQuoteAction("OUTSIDE_DHAKA");
  assert.deepEqual([q.required, providerCalls.length], [200, 0]);
  assert.deepEqual(Object.keys(q).sort(), ["instructions", "required"]);                                     // nothing about scores or history is returned
});

// ---- admin recheck ----------------------------------------------------------------------------------------------------------------------------
const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
const DENIED: [string, string | null][] = [["nobody", null], ["unknown id", "ghost"], ["a CUSTOMER account", "cust-9"], ["a deactivated admin", "adm-off"]];

for (const [label, id] of DENIED) {
  test(`recheck refuses ${label}: no provider call, no change, no audit`, async () => {
    records.set(PHONE, { delivered: 1, cancelled: 0 });
    const o = await place();
    const before = JSON.stringify(row(o.id).trustSnapshot);
    providerCalls = [];
    await assert.rejects(recheckOrderFraud({ orderId: o.id, adminId: id, now: later(300) }), /not authorised/i);
    assert.deepEqual([providerCalls.length, JSON.stringify(row(o.id).trustSnapshot) === before, audits("FRAUD_RECHECK").length], [0, true, 0]);
  });
}

test("the recheck action refuses anyone who is not signed in as an admin", async () => {
  const o = await place();
  providerCalls = [];
  await assert.rejects(recheckFraudAction({ orderId: o.id }), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "cust-9" }, () => recheckFraudAction({ orderId: o.id })), /FORBIDDEN/);
  assert.deepEqual([providerCalls.length, audits("FRAUD_RECHECK").length], [0, 0]);
});

test("a recheck asks the provider again, records the new result next to the old one, audits it without the phone, and changes nothing else", async () => {
  records.set(PHONE, { delivered: 1, cancelled: 0 });
  const o = await place();
  const before = row(o.id);
  const original = JSON.stringify((before.trustSnapshot as any).fraudCheck);
  records.set(PHONE, { delivered: 1, cancelled: 3, returned: 1, total: 6 });                                  // the history got worse since checkout
  providerCalls = [];
  const res = await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(120) });
  assert.deepEqual([providerCalls.length, res.status, res.source, res.score, res.tier], [1, "ok", "provider", 0, "low"]);   // 50 - 3*20, clamped at 0

  const after = row(o.id);
  const snap = after.trustSnapshot as any;
  assert.equal(JSON.stringify(snap.fraudCheck), original);                                                    // the order-time evidence is never overwritten
  assert.deepEqual([snap.recheck.cancelled, snap.recheck.total, snap.recheck.byId, snap.recheck.score], [3, 6, "a1", 0]);
  assert.deepEqual([after.trustScore, Number(after.advanceRequired), Number(after.advancePaid), after.trustReviewRequired, after.paymentStatus],
    [before.trustScore, Number(before.advanceRequired), Number(before.advancePaid), before.trustReviewRequired, before.paymentStatus]);   // nothing else moved

  const [event] = audits("FRAUD_RECHECK");
  assert.deepEqual([event.actorId, event.entityType, event.entityId], ["a1", "ORDER", o.id]);
  assert.equal(JSON.stringify(event).includes(PHONE) || JSON.stringify(event).includes("1711000001"), false);
});

test("a recheck is refused for a minute after any check of that order, and the panel shows the phone and both results to the admin", async () => {
  records.set(PHONE, { delivered: 2, cancelled: 0 });
  const o = await place();
  await assert.rejects(recheckOrderFraud({ orderId: o.id, adminId: "a1" }), /checked a moment ago\. Try again in \d+ second/);
  await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(61) });
  await assert.rejects(recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(62) }), /Try again in/);
  const panel = (await getAdvancePanel(o.id))!;
  assert.equal(panel.phone, PHONE);
  assert.deepEqual([panel.trust!.fraudCheck!.source, panel.trust!.recheck!.source, panel.trust!.fraudCheck!.total, panel.trust!.recheck!.byId], ["provider", "provider", 2, "a1"]);
  assert.equal(typeof panel.trust!.recheck!.checkedAt, "string");
});

test("a recheck with the provider down, or none configured, records an honest fallback and still never raises trust", async () => {
  records.set(PHONE, { delivered: 4, cancelled: 0 });
  const o = await place();
  mode = "throw";
  const down = await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(120) });
  assert.deepEqual([down.status, down.reason, down.source, down.score], ["unavailable", "error", "fallback", 50]);
  setFraudCheckProviderForTests(null);
  const none = await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(240) });
  assert.deepEqual([none.reason, none.source, none.score], ["no_provider", "fallback", 50]);
  assert.equal(audits("FRAUD_RECHECK").length, 2);
});

test("only the latest five rechecks are kept", async () => {
  const o = await place();
  for (let i = 1; i <= 7; i++) await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(120 * i) });
  assert.equal(((row(o.id).trustSnapshot as any).rechecks as unknown[]).length, 5);
  assert.equal(audits("FRAUD_RECHECK").length, 7);
});

test("a recheck needs an existing order that has a trust record", async () => {
  await assert.rejects(recheckOrderFraud({ orderId: "no-such-order", adminId: "a1" }), /Order not found/);
  const o = await place();
  db.patch("order", o.id, { trustSnapshot: null });
  await assert.rejects(recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(300) }), /no trust record/);
});
