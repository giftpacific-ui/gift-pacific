/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { placeOrder } from "@/server/services/order.service";
import { getAdvancePanel, recheckOrderFraud, saveAdvanceSettings } from "@/server/services/advance.service";
import { resetIntelligenceStateForTests, setIntelligenceAdaptersForTests, setIntelligenceClockForTests, setPhoneVerifiedForTests } from "@/server/services/courier-intelligence.service";
import { getAdvanceQuoteAction } from "@/server/actions/checkout.actions";
import { recheckFraudAction } from "@/server/actions/admin-advance.actions";
import { EMPTY_METRICS } from "@/lib/courier-intelligence/types";

/**
 * Checkout enforcement and the admin recheck, end to end through the real services on the in-memory database.
 * The courier adapter below is a STAND-IN that exists only in this test file. These tests prove OUR rules; they say nothing about the real courier,
 * and the in-memory database does not prove real locking or concurrency.
 */
let db: FakeDb;
let providerCalls: string[] = [];
const records = new Map<string, { delivered: number; cancelled: number; total?: number; fraudReports?: number | null }>();
let mode: "ok" | "throw" | "badshape" = "ok";
const saved: Record<string, string | undefined> = {};
const ENV = ["FRAUD_CHECK_CACHE_SECONDS", "RATE_LIMIT_ENABLED", "FRAUD_CHECK_ENABLED"];

const policy = { enabled: true, zones: ["OUTSIDE_DHAKA"] as never, standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true, instructions: "Send to bKash 01XXXXXXXXX" };
const PHONE = "01711000001";
const adapter = {
  key: "steadfast" as const,
  lookup: async (phone: string) => {
    providerCalls.push(phone);
    if (mode === "throw") throw new Error("provider down");
    if (mode === "badshape") return { ok: false as const, reason: "invalid_response" as const };
    const r = records.get(phone) ?? { delivered: 0, cancelled: 0 };
    const total = r.total ?? r.delivered + r.cancelled;
    return { ok: true as const, metrics: { ...EMPTY_METRICS, delivered: r.delivered, cancelled: r.cancelled, total, fraudReports: r.fraudReports ?? 0, empty: total === 0 } };
  },
};

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.FRAUD_CHECK_CACHE_SECONDS = "0";
  process.env.RATE_LIMIT_ENABLED = "false";
  providerCalls = []; records.clear(); mode = "ok";
  resetIntelligenceStateForTests();
  setPhoneVerifiedForTests(undefined);                                   // the REAL default: no phone is verified
  setIntelligenceAdaptersForTests({ steadfast: adapter });
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
  setIntelligenceAdaptersForTests(undefined);
  setIntelligenceClockForTests(undefined);
  setPhoneVerifiedForTests(undefined);
  resetIntelligenceStateForTests();
});

let n = 0;
const place = (phone = PHONE, extra: Record<string, unknown> = {}) =>
  runAs(null, async () => {
    await addItemToCart({ productId: "p-standard", quantity: 1 });
    return placeOrder({ ...emptyCheckout, deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Sylhet", phone }, advanceMethod: "BKASH", advanceReference: `TXFRAUD${String(++n).padStart(5, "0")}`, ...extra } as never);
  });
const row = (id: string) => db.get("order", id);
const audits = (action: string) => db.rows("adminAuditEvent").filter((e) => e.action === action);
const fc = (id: string) => (row(id).trustSnapshot as any).fraudCheck;
const courier = (id: string) => (row(id).trustSnapshot as any).courier;
const withPolicy = (over: Record<string, unknown>) => saveAdvanceSettings({ ...policy, ...over } as never, "a1");

// ---- checkout: the server decides, whatever the courier says ----------------------------------------------------------------------------------
test("checkout: a perfect record (enough parcels) does NOT lower the advance by default; the order stores the courier evidence, not the phone", async () => {
  records.set(PHONE, { delivered: 8, cancelled: 0 });
  const o = await place();
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), r.trustReviewRequired], [100, 200, false]);   // standard tier: reward is off, so no reduction, and no review needed
  assert.deepEqual([fc(o.id).status, fc(o.id).source, fc(o.id).provider, fc(o.id).delivered, fc(o.id).cancelled, fc(o.id).total, fc(o.id).phoneVerified], ["ok", "provider", "steadfast", 8, 0, 8, false]);
  const c = courier(o.id);
  assert.deepEqual([c.model, c.state, c.rate, c.sample, c.providers, c.rewardAllowed, c.phoneMasked], ["courier-rate-v2", "rated", 100, 8, ["steadfast"], false, "017*****001"]);
  assert.deepEqual(c.providerReports.map((p: any) => [p.provider, p.status]), [["steadfast", "ok"], ["pathao", "unsupported"], ["redx", "unsupported"]]);
  assert.deepEqual(c.policy, { minSample: 5, minProviders: 1, maxAgeSeconds: 3600, rewardEnabled: false, creditUnverifiedPhone: false });
  assert.equal(JSON.stringify(r.trustSnapshot).includes(PHONE), false);                                    // the phone number itself is not stored in the snapshot
  assert.equal(providerCalls.length, 1);
});

test("checkout: a poor record (enough parcels) is the low tier: standard advance AND a staff review", async () => {
  records.set(PHONE, { delivered: 1, cancelled: 4 });
  const o = await place();
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), r.trustReviewRequired], [20, 200, true]);
  assert.deepEqual([fc(o.id).delivered, fc(o.id).cancelled, fc(o.id).total], [1, 4, 5]);
});

test("checkout: too few parcels is UNRATED, however good the percentage: no score is stored, standard advance + review", async () => {
  records.set(PHONE, { delivered: 1, cancelled: 0 });                          // 1 of 1 = 100%, but a sample of one proves nothing
  const o = await place();
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), r.trustReviewRequired], [null, 200, true]);
  assert.deepEqual([courier(o.id).state, courier(o.id).rate, courier(o.id).observedRate, courier(o.id).sample], ["insufficient", null, 100, 1]);
  assert.equal((r.trustSnapshot as any).insufficientEvidence, true);
});

test("checkout: no parcel history is unrated; a courier answer of zero is a real answer, not a failure", async () => {
  records.set(PHONE, { delivered: 0, cancelled: 0 });
  const o = await place();
  assert.deepEqual([row(o.id).trustScore, Number(row(o.id).advanceRequired), row(o.id).trustReviewRequired, fc(o.id).status, courier(o.id).state], [null, 200, true, "no_history", "no_history"]);
});

test("checkout: courier failure, no courier, a bad phone and a switched-off check all use the safe fallback (unrated) and never block the order", async () => {
  mode = "throw";
  const failed = await place();
  assert.deepEqual([row(failed.id).trustScore, Number(row(failed.id).advanceRequired), row(failed.id).trustReviewRequired], [null, 200, true]);
  assert.deepEqual([fc(failed.id).status, fc(failed.id).reason, fc(failed.id).source], ["unavailable", "error", "fallback"]);

  mode = "badshape";
  const bad = await place();
  assert.deepEqual([fc(bad.id).reason, row(bad.id).trustScore, Number(row(bad.id).advanceRequired)], ["invalid_response", null, 200]);

  mode = "ok"; setIntelligenceAdaptersForTests({ steadfast: null });
  const none = await place();
  assert.deepEqual([fc(none.id).reason, Number(row(none.id).advanceRequired), row(none.id).trustScore], ["no_provider", 200, null]);

  setIntelligenceAdaptersForTests({ steadfast: adapter });
  records.set("01711000009", { delivered: 9, cancelled: 0 });
  const badPhone = await place("123456");
  assert.deepEqual([fc(badPhone.id).reason, Number(row(badPhone.id).advanceRequired), row(badPhone.id).trustScore], ["invalid_phone", 200, null]);
  process.env.FRAUD_CHECK_ENABLED = "false";
  try {
    const off = await place();
    assert.deepEqual([fc(off.id).reason, Number(row(off.id).advanceRequired)], ["disabled", 200]);
  } finally { delete process.env.FRAUD_CHECK_ENABLED; }
});

test("an outage can NEVER lower the advance, even with every reward switch on and a verified phone", async () => {
  await withPolicy({ rewardEnabled: true, creditUnverifiedPhone: true });
  setPhoneVerifiedForTests(true);
  for (const m of ["throw", "badshape"] as const) {
    mode = m;
    const o = await place();
    assert.deepEqual([Number(row(o.id).advanceRequired), row(o.id).trustScore], [200, null], m);
  }
  setIntelligenceAdaptersForTests({ steadfast: null });
  assert.equal(Number(row((await place()).id).advanceRequired), 200);
});

test("checkout: a claim without a payment reference is still refused even when the courier is down (no bypass through failure)", async () => {
  mode = "throw";
  await assert.rejects(place(PHONE, { advanceReference: "" }), /advance of 200 is required/);
  assert.equal(db.rows("order").length, 0);
});

test("checkout: scores, statistics and amounts sent by the browser are ignored", async () => {
  records.set(PHONE, { delivered: 0, cancelled: 0 });
  const o = await place(PHONE, { trustScore: 100, trustTier: "full", fraudCheck: { status: "ok", delivered: 99, cancelled: 0 }, courier: { rate: 100 }, advanceRequired: 0, advancePaid: 5000, needsReview: false } as never);
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), Number(r.advancePaid)], [null, 200, 0]);
  assert.notEqual(fc(o.id).delivered, 99);
  assert.equal(courier(o.id).rate, null);
});

test("positive evidence lowers the advance ONLY when the policy enables it AND the phone is verified or explicitly accepted", async () => {
  records.set(PHONE, { delivered: 9, cancelled: 1 });                           // 90%
  const adv = async () => Number(row((await place()).id).advanceRequired);
  assert.equal(await adv(), 200);                                              // default policy: reward off
  await withPolicy({ rewardEnabled: true });
  assert.equal(await adv(), 200);                                              // switch on, phone NOT verified and unverified not accepted
  setPhoneVerifiedForTests(true);
  assert.equal(await adv(), 100);                                              // verified phone (simulated): reduced tier
  setPhoneVerifiedForTests(undefined);
  await withPolicy({ rewardEnabled: true, creditUnverifiedPhone: true });
  assert.equal(await adv(), 100);                                              // the admin explicitly accepts unverified phones
  await withPolicy({ rewardEnabled: false, creditUnverifiedPhone: true });
  assert.equal(await adv(), 200);                                              // acceptance alone does nothing
});

test("the full tier only at the configured rate and sample; a small sample never qualifies for it", async () => {
  await withPolicy({ rewardEnabled: true, creditUnverifiedPhone: true });
  records.set(PHONE, { delivered: 2, cancelled: 0 });
  const small = await place();
  assert.deepEqual([Number(row(small.id).advanceRequired), row(small.id).trustScore], [200, null]);   // 100%, but only 2 parcels
  records.set("01711000002", { delivered: 6, cancelled: 0 });
  const full = await place("01711000002");
  assert.deepEqual([Number(row(full.id).advanceRequired), row(full.id).trustScore, courier(full.id).state], [100, 100, "rated"]);   // full tier, zero NOT waived by default
  await withPolicy({ rewardEnabled: true, creditUnverifiedPhone: true, zeroAtFullTrust: true });
  assert.equal(Number(row((await place("01711000002")).id).advanceRequired), 0);
  await withPolicy({ rewardEnabled: true, creditUnverifiedPhone: true, minSample: 10 });
  assert.equal(Number(row((await place("01711000002")).id).advanceRequired), 200);                     // the admin raised the bar
  await withPolicy({ rewardEnabled: true, creditUnverifiedPhone: true, minProviders: 2 });
  assert.equal(Number(row((await place("01711000002")).id).advanceRequired), 200);                     // only one courier can answer: not enough coverage
});

test("a courier that is not Steadfast (Pathao, REDX) cannot affect checkout: they are unsupported and never called", async () => {
  const trap = { key: "steadfast" as const, lookup: async (p: string) => { providerCalls.push(`TRAP:${p}`); return { ok: true as const, metrics: { ...EMPTY_METRICS, delivered: 99, cancelled: 0, total: 99, empty: false } }; } };
  setIntelligenceAdaptersForTests({ steadfast: adapter, pathao: trap as any, redx: trap as any });
  records.set(PHONE, { delivered: 1, cancelled: 4 });
  const o = await place();
  assert.deepEqual([row(o.id).trustScore, providerCalls], [20, [PHONE]]);
});

test("checkout: repeated orders for one phone make ONE courier call while the cache is valid, and different phones do not share results", async () => {
  process.env.FRAUD_CHECK_CACHE_SECONDS = "600";
  records.set(PHONE, { delivered: 6, cancelled: 1 });
  const a = await place(); const b = await place();
  assert.equal(providerCalls.length, 1);
  assert.deepEqual([fc(a.id).cached, fc(b.id).cached], [false, true]);
  assert.equal(row(a.id).trustScore, row(b.id).trustScore);
  await place("01711000002");
  assert.equal(providerCalls.length, 2);
});

test("evidence older than the policy's maximum age is not used even while the cache would serve it", async () => {
  let t = 1_800_000_000_000;
  setIntelligenceClockForTests(() => t);
  process.env.FRAUD_CHECK_CACHE_SECONDS = "86400";
  await withPolicy({ maxAgeSeconds: 120 });
  records.set(PHONE, { delivered: 6, cancelled: 0 });
  await place();
  t += 60_000;
  await place();
  assert.equal(providerCalls.length, 1);          // 60 s old: within the policy
  t += 120_000;
  await place();
  assert.equal(providerCalls.length, 2);          // 180 s old: asked again
});

test("the checkout price preview never calls a courier (so it cannot be used to probe phone numbers) and shows the standard advance", async () => {
  const q = await getAdvanceQuoteAction("OUTSIDE_DHAKA");
  assert.deepEqual([q.required, providerCalls.length], [200, 0]);
  assert.deepEqual(Object.keys(q).sort(), ["instructions", "required"]);                                     // nothing about scores or history is returned
});

// ---- admin recheck ----------------------------------------------------------------------------------------------------------------------------
const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
const DENIED: [string, string | null][] = [["nobody", null], ["unknown id", "ghost"], ["a CUSTOMER account", "cust-9"], ["a deactivated admin", "adm-off"]];

for (const [label, id] of DENIED) {
  test(`recheck refuses ${label}: no courier call, no change, no audit`, async () => {
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

test("a recheck asks the courier again, records the new result next to the old one, audits it without the phone, and changes nothing else", async () => {
  records.set(PHONE, { delivered: 8, cancelled: 0 });
  const o = await place();
  const before = row(o.id);
  const original = JSON.stringify((before.trustSnapshot as any).fraudCheck);
  records.set(PHONE, { delivered: 1, cancelled: 9, total: 12 });                                              // the history got worse since checkout
  providerCalls = [];
  const res = await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(120) });
  assert.deepEqual([providerCalls.length, res.status, res.source, res.score, res.tier], [1, "ok", "provider", 10, "low"]);   // 1 delivered of 10 delivered-or-cancelled = 10%

  const after = row(o.id);
  const snap = after.trustSnapshot as any;
  assert.equal(JSON.stringify(snap.fraudCheck), original);                                                    // the order-time evidence is never overwritten
  assert.deepEqual([snap.recheck.cancelled, snap.recheck.total, snap.recheck.byId, snap.recheck.score], [9, 12, "a1", 10]);
  assert.deepEqual([snap.recheck.courier.rate, snap.recheck.courier.providers, snap.rechecks.length], [10, ["steadfast"], 1]);   // per-courier detail of the recheck is kept too
  assert.deepEqual([after.trustScore, Number(after.advanceRequired), Number(after.advancePaid), after.trustReviewRequired, after.paymentStatus],
    [before.trustScore, Number(before.advanceRequired), Number(before.advancePaid), before.trustReviewRequired, before.paymentStatus]);   // nothing else moved

  const [event] = audits("FRAUD_RECHECK");
  assert.deepEqual([event.actorId, event.entityType, event.entityId], ["a1", "ORDER", o.id]);
  assert.equal(JSON.stringify(event).includes(PHONE) || JSON.stringify(event).includes("1711000001"), false);
});

test("a recheck is refused for a minute after any check of that order, and the panel shows the phone and both results to the admin", async () => {
  records.set(PHONE, { delivered: 6, cancelled: 0 });
  const o = await place();
  await assert.rejects(recheckOrderFraud({ orderId: o.id, adminId: "a1" }), /checked a moment ago\. Try again in \d+ second/);
  await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(61) });
  await assert.rejects(recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(62) }), /Try again in/);
  const panel = (await getAdvancePanel(o.id))!;
  assert.equal(panel.phone, PHONE);
  assert.deepEqual([panel.trust!.fraudCheck!.source, panel.trust!.recheck!.source, panel.trust!.fraudCheck!.total, panel.trust!.recheck!.byId], ["provider", "provider", 6, "a1"]);
  assert.equal(panel.trust!.courier!.model, "courier-rate-v2");           // the per-courier evidence frozen at checkout reaches the admin panel
  assert.equal(typeof panel.trust!.recheck!.checkedAt, "string");
});

test("a recheck with the courier down, or none configured, records an honest fallback (unrated) and never raises trust", async () => {
  records.set(PHONE, { delivered: 6, cancelled: 0 });
  const o = await place();
  mode = "throw";
  const down = await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(120) });
  assert.deepEqual([down.status, down.reason, down.source, down.score], ["unavailable", "error", "fallback", null]);
  setIntelligenceAdaptersForTests({ steadfast: null });
  const none = await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: later(240) });
  assert.deepEqual([none.reason, none.source, none.score], ["no_provider", "fallback", null]);
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
