/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The admin Fraud Checker and the order page, end to end through the REAL services on the in-memory database: the assembled display data,
 * the customer risk lookup, who may do what, and the limits on manual rechecks. The courier adapter is a STAND-IN in this file (Pathao and REDX
 * have no adapter in production, and the real Steadfast is never called). The in-memory database does not prove real locking.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { placeOrder } from "@/server/services/order.service";
import { saveAdvanceSettings } from "@/server/services/advance.service";
import { evaluateOrderRisk, saveFraudPolicy } from "@/server/services/fraud-risk.service";
import { adminCheckProvider, getOrderCourierView, getPhoneRiskSummary } from "@/server/services/courier-intelligence-admin.service";
import { resetIntelligenceStateForTests, setIntelligenceAdaptersForTests, setIntelligenceClockForTests, setPhoneVerifiedForTests } from "@/server/services/courier-intelligence.service";
import { checkCourierProviderAction, lookupPhoneRiskAction } from "@/server/actions/admin-courier-intelligence.actions";
import { recheckFraudAction } from "@/server/actions/admin-advance.actions";
import { bucketKey, RATE_LIMITS } from "@/lib/rate-limit";
import { normalizeBdPhone } from "@/lib/fraud/identity";
import { EMPTY_METRICS } from "@/lib/courier-intelligence/types";

let db: FakeDb;
let calls: string[] = [];
const records = new Map<string, { delivered: number; cancelled: number; fraudReports?: number | null }>();
let mode: "ok" | "throw" | "timeout" = "ok";
const saved: Record<string, string | undefined> = {};
const ENV = ["FRAUD_CHECK_CACHE_SECONDS", "RATE_LIMIT_ENABLED", "FRAUD_CHECK_ENABLED", "AUTH_SECRET", "FRAUD_CHECK_MAX_CALLS_PER_MINUTE"];
const PHONE = "01711000001";
const policy = { enabled: true, zones: ["OUTSIDE_DHAKA"] as never, standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true, instructions: "Send to bKash 01XXXXXXXXX" };
const adapter = {
  key: "steadfast" as const,
  lookup: async (phone: string) => {
    calls.push(phone);
    if (mode === "throw") throw new Error(`provider down ${phone}`);
    if (mode === "timeout") return { ok: false as const, reason: "timeout" as const };
    const r = records.get(phone) ?? { delivered: 0, cancelled: 0 };
    const total = r.delivered + r.cancelled;
    return { ok: true as const, metrics: { ...EMPTY_METRICS, delivered: r.delivered, cancelled: r.cancelled, total, fraudReports: r.fraudReports ?? 0, empty: total === 0 } };
  },
};

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.FRAUD_CHECK_CACHE_SECONDS = "600";
  delete process.env.RATE_LIMIT_ENABLED;            // rate limiting is ON: it is part of what these tests prove
  process.env.AUTH_SECRET = "test-secret-for-hashing-0123456789";
  calls = []; records.clear(); mode = "ok";
  resetIntelligenceStateForTests();
  setPhoneVerifiedForTests(undefined);
  setIntelligenceAdaptersForTests({ steadfast: adapter });
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer", role: "CUSTOMER", isActive: true });
  db.insert("user", { id: "adm-off", email: "off@staff.test", name: "Deactivated", role: "ADMIN", isActive: false });
  db.patch("product", "p-standard", { stock: 1000 });
  await saveAdvanceSettings(policy as never, "a1");
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setIntelligenceAdaptersForTests(undefined); setIntelligenceClockForTests(undefined); setPhoneVerifiedForTests(undefined); resetIntelligenceStateForTests();
});

let n = 0;
const place = (phone = PHONE) =>
  runAs(null, async () => {
    await addItemToCart({ productId: "p-standard", quantity: 1 });
    return placeOrder({ ...emptyCheckout, phone, deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Sylhet", phone }, advanceMethod: "BKASH", advanceReference: `TXVIEW${String(++n).padStart(5, "0")}` } as never);
  });
const audits = (action: string) => db.rows("adminAuditEvent").filter((e) => e.action === action);
const hourlyUsed = (adminId: string) => [...(db as any).rateBuckets.entries()].filter(([k]: [string, number]) => k.startsWith(bucketKey(RATE_LIMITS.courierLookupAdmin.name, adminId))).reduce((a: number, [, v]: [string, number]) => a + v, 0);
/** Seeds past website orders for a phone (history the risk score reads). */
let h = 0;
const pastOrder = (phone: string, status: string, events: string[] = []) => {
  const id = `past-${++h}`;
  db.insert("order", { id, orderNumber: `GP-P${h}`, channelId: "channel_website", status, phone, phoneNorm: normalizeBdPhone(phone) ?? "-", email: null, emailNorm: null, addressKey: null, userId: null, total: 500, createdAt: new Date("2026-10-01T00:00:00Z"), riskReviewDecision: null, riskLevel: null, riskReviewRequired: false, shippingSnapshot: {} });
  events.forEach((s, i) => db.insert("orderTrackingEvent", { id: `${id}-e${i}`, orderId: id, status: s, createdAt: new Date("2026-10-01T00:00:00Z") }));
};

// =====================================================================================================================================================
// 1. The order page: assembled display data
// =====================================================================================================================================================
test("order page data: Steadfast's history, the combined result, last checked, and saved-or-fresh, all from stored data (Pathao and REDX are not shown)", async () => {
  records.set(PHONE, { delivered: 9, cancelled: 1, fraudReports: 0 });
  const o = await place();
  const callsAtCheckout = calls.length;
  const v = (await getOrderCourierView(o.id, { adminId: "a1" }))!;
  assert.equal(calls.length, callsAtCheckout, "opening the order calls no courier");
  const h = v.history!;
  assert.deepEqual(h.cards.map((c) => [c.provider, c.status]), [["steadfast", "ok"]]);
  assert.deepEqual([h.cards[0].counts!.delivered.text, h.cards[0].counts!.cancelled.text, h.cards[0].counts!.returned.text, h.cards[0].counts!.failed.text], ["9", "1", "not reported", "not reported"]);
  assert.deepEqual([h.combined.rate, h.combined.delivered.text, h.combined.cancelled.text, h.combined.couriers], [90, "9", "1", ["Steadfast"]]);
  assert.ok(h.lastCheckedAt && h.lastCheckedText);
  assert.deepEqual([h.freshness, h.cards[0].source], ["cached", "cached"], "an order page reads the saved result and says so");
  assert.deepEqual(h.warnings, [], "a healthy Steadfast and two couriers that are never asked: no warnings");
  assert.ok(!/pathao|redx/i.test(JSON.stringify(v.history)), "the display data does not mention them");
  assert.equal(v.panel.phoneMasked, "017*****001");
});

test("order page data: a courier that was not asked is 'not checked' with a warning, and the page says no data rather than showing zeros", async () => {
  process.env.FRAUD_CHECK_ENABLED = "false";                      // checkout stores nothing
  const o = await place();
  const h = (await getOrderCourierView(o.id, { adminId: "a1" }))!.history!;
  assert.equal(h.cards[0].status, "not_checked");
  assert.equal(h.combined.hasData, false);
  assert.deepEqual([h.combined.delivered.text, h.combined.cancelled.text], ["no data", "no data"]);
  assert.match(h.noDataNotice ?? "", /never rejects or penalises an order/);
  assert.ok(h.warnings.some((w) => w.provider === "steadfast" && w.kind === "not_checked"));
});

test("order page data: Steadfast down at checkout shows an UNAVAILABLE warning, 'no data' counts, and a risk note that it was not counted", async () => {
  mode = "timeout";
  const o = await place();
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null });
  const v = (await getOrderCourierView(o.id, { adminId: "a1" }))!;
  const sf = v.history!.cards[0];
  assert.deepEqual([sf.status, sf.warning?.kind, sf.warning?.severity, sf.counts], ["unavailable", "unavailable", "warn", null]);
  assert.match(sf.warning!.text, /not counted as zero deliveries/);
  assert.deepEqual([v.history!.combined.hasData, v.history!.combined.delivered.text], [false, "no data"]);
  assert.equal(v.risk!.assessed, true);
  assert.match(v.risk!.courierNote, /No courier history was available, so it is not counted in this score/);
});

test("order page data: the stored risk score and EVERY reason come with it (level, points, direction), read from the assessment, not recalculated", async () => {
  records.set(PHONE, { delivered: 9, cancelled: 15 });          // a poor record with enough parcels: the low-trust signal
  pastOrder(PHONE, "CANCELLED", ["CANCELLED"]); pastOrder(PHONE, "CANCELLED", ["CANCELLED"]);
  const o = await place();
  const stored = await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null });
  const v = (await getOrderCourierView(o.id, { adminId: "a1" }))!;
  const codes = v.risk!.reasons.map((r) => r.code);
  assert.ok(codes.includes("PRIOR_CANCELLED") && codes.includes("LOW_TRUST_EVIDENCE"), codes.join());
  assert.equal(v.risk!.score, stored!.score);
  assert.equal(v.risk!.level, db.get("order", o.id).riskLevel);
  assert.ok(v.risk!.reasons.every((r) => r.points !== 0 && (r.direction === "raises") === r.points > 0));
  assert.match(v.risk!.courierNote, /Courier delivery history raised this score by \d+/);
  assert.equal(db.rows("orderRiskAssessment").filter((a) => a.orderId === o.id).length, 1, "building the view added no assessment");
});

test("order page data: before an assessment exists the risk view says 'not assessed' (no made-up score); with scoring switched OFF there is no risk block at all", async () => {
  const o = await place();
  db.patch("order", o.id, { riskScore: null, riskLevel: null, riskAssessedAt: null, riskAssessmentId: null });
  const before = (await getOrderCourierView(o.id, { adminId: "a1" }))!;
  assert.deepEqual([before.risk?.assessed, before.risk?.score], [false, null]);
  await saveFraudPolicy({ mode: "OFF" }, "a1");
  assert.equal((await getOrderCourierView(o.id, { adminId: "a1" }))!.risk, null);
});

test("order page data: an order with no valid delivery phone has no history to show; an unknown order is null", async () => {
  const o = await place();
  db.patch("order", o.id, { phone: "12", shippingSnapshot: { phone: "12" } });
  const addr = db.rows("address").find((a) => a.id === db.get("order", o.id).shippingAddressId);
  if (addr) db.patch("address", addr.id, { phone: "12" });
  const v = (await getOrderCourierView(o.id, { adminId: "a1" }))!;
  assert.deepEqual([v.panel.stored, v.history], [null, null]);
  assert.equal(await getOrderCourierView("missing", { adminId: "a1" }), null);
});

// =====================================================================================================================================================
// 2. Fraud Checker: customer risk for any phone (stored data only)
// =====================================================================================================================================================
test("fraud checker: a phone that ordered here shows the latest risk score with its reasons, the order's number, and our own order outcomes", async () => {
  pastOrder(PHONE, "CANCELLED", ["CANCELLED"]); pastOrder(PHONE, "DELIVERED", ["CONFIRMED", "DELIVERED"]);
  const o = await place();
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null });
  calls = [];
  const r = await getPhoneRiskSummary({ adminId: "a1", phone: "+8801711000001" });
  assert.equal(calls.length, 0, "a risk lookup never calls a courier");
  assert.deepEqual([r.phoneValid, r.phoneMasked, r.riskMode, r.riskOrderNumber], [true, "017*****001", "ENFORCE", db.get("order", o.id).orderNumber]);
  assert.equal(r.risk!.score, db.get("order", o.id).riskScore);
  assert.ok(r.risk!.reasons.some((x) => x.code === "PRIOR_CANCELLED"));
  assert.deepEqual([r.internal!.total, r.internal!.cancelled, r.internal!.delivered], [3, 1, 1]);
  const [event] = audits("CUSTOMER_RISK_LOOKUP");
  assert.deepEqual([event.actorId, event.detail], ["a1", { phoneMasked: "017*****001", hadRisk: true }]);
  assert.ok(!JSON.stringify(event).includes("01711000001") && !JSON.stringify(r).includes("01711000001"), "only the masked number is returned or audited");
});

test("fraud checker: a phone that never ordered here has no score (and says so), an invalid number is rejected, and scoring OFF returns no score", async () => {
  const none = await getPhoneRiskSummary({ adminId: "a1", phone: "01899999999" });
  assert.deepEqual([none.phoneValid, none.risk, none.riskOrderNumber], [true, null, null]);
  const bad = await getPhoneRiskSummary({ adminId: "a1", phone: "12345" });
  assert.deepEqual([bad.phoneValid, bad.phoneMasked, bad.risk, bad.internal], [false, null, null, null]);
  assert.equal(audits("CUSTOMER_RISK_LOOKUP").length, 1, "an invalid number is not audited as a lookup");
  const o = await place();
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null });
  await saveFraudPolicy({ mode: "OFF" }, "a1");
  const off = await getPhoneRiskSummary({ adminId: "a1", phone: PHONE });
  assert.deepEqual([off.riskMode, off.risk], ["OFF", null]);
});

test("fraud checker: only an ACTIVE ADMIN may look up a customer's risk; a customer, a deactivated admin and no one are refused before anything is read or counted", async () => {
  for (const adminId of ["cust-9", "adm-off", "nobody", null, undefined]) {
    await assert.rejects(getPhoneRiskSummary({ adminId, phone: PHONE }), /not authorised|authoris/i, String(adminId));
  }
  assert.equal(audits("CUSTOMER_RISK_LOOKUP").length, 0);
  assert.equal((db as any).rateBuckets.size, 0, "a refused caller uses up no budget");
  await assert.rejects(lookupPhoneRiskAction({ phone: PHONE }), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "cust-9" }, () => lookupPhoneRiskAction({ phone: PHONE })), /FORBIDDEN/);
  const ok = await runAs("admin", () => lookupPhoneRiskAction({ phone: PHONE }));
  assert.equal(ok.success, true);
});

test("fraud checker: the risk lookup is rate limited per admin", async () => {
  for (let i = 0; i < RATE_LIMITS.riskLookupAdmin.limit; i++) await getPhoneRiskSummary({ adminId: "a1", phone: "12" });
  await assert.rejects(getPhoneRiskSummary({ adminId: "a1", phone: "12" }), /Too many attempts/);
  const other = await getPhoneRiskSummary({ adminId: "a2", phone: "12" });
  assert.equal(other.phoneValid, false, "another admin is unaffected");
  const viaAction = await runAs("admin", () => lookupPhoneRiskAction({ phone: PHONE }));
  assert.equal(viaAction.success, true, "admin-1 has its own budget");
});

// =====================================================================================================================================================
// 3. Manual rechecks: permissions and rate limits
// =====================================================================================================================================================
test("a courier that cannot be asked (Pathao, REDX, or Steadfast without credentials) costs NO lookup budget, so three couriers per click no longer drain it", async () => {
  for (let i = 0; i < RATE_LIMITS.courierLookupAdmin.limit + 10; i++) {
    const r = await adminCheckProvider({ adminId: "a1", phone: PHONE, provider: i % 2 ? "pathao" : "redx", fresh: true });
    assert.equal(r.report.status, "unsupported");
  }
  assert.equal(hourlyUsed("a1"), 0);
  setIntelligenceAdaptersForTests({ steadfast: null });
  assert.equal((await adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "steadfast", fresh: true })).report.status, "not_configured");
  assert.equal(hourlyUsed("a1"), 0);
  setIntelligenceAdaptersForTests({ steadfast: adapter });
  assert.equal((await adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "steadfast", fresh: false })).report.status, "no_history");
  assert.equal(hourlyUsed("a1"), 1, "only the courier that was really asked is charged");
});

test("the hourly lookup budget still applies to couriers that are asked: 90 per admin per hour, then refused; another admin is unaffected", async () => {
  for (let i = 0; i < RATE_LIMITS.courierLookupAdmin.limit; i++) await adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "steadfast", fresh: false });
  await assert.rejects(adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "steadfast", fresh: false }), /Too many attempts/);
  assert.equal((await adminCheckProvider({ adminId: "a2", phone: PHONE, provider: "steadfast", fresh: false })).report.status, "no_history");
});

test("'Refresh from the couriers' is limited to once per 30 s per admin, courier AND phone; the refused refresh calls no courier and does not use the hourly budget", async () => {
  const realNow = Date.now;
  try {
    const t0 = Math.floor(realNow() / 30_000) * 30_000 + 1000;   // inside one fixed 30 s window
    Date.now = () => t0;
    const first = await adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "steadfast", fresh: true });
    assert.equal(first.report.cached, false);
    assert.equal(calls.length, 1);
    Date.now = () => t0 + 5_000;
    await assert.rejects(adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "steadfast", fresh: true }), /just refreshed for this number\. Try again in \d+ seconds?\./);
    assert.equal(calls.length, 1, "no second courier call");
    assert.equal(hourlyUsed("a1"), 1, "the refused refresh did not spend the hourly budget");
    // other admin, other phone, and a non-refresh check are all unaffected
    assert.equal((await adminCheckProvider({ adminId: "a2", phone: PHONE, provider: "steadfast", fresh: true })).report.status, "no_history");
    assert.equal((await adminCheckProvider({ adminId: "a1", phone: "01811000002", provider: "steadfast", fresh: true })).report.status, "no_history");
    assert.equal((await adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "steadfast", fresh: false })).report.cached, true);
    // after the window it works again
    Date.now = () => t0 + 31_000;
    assert.equal((await adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "steadfast", fresh: true })).report.cached, false);
  } finally { Date.now = realNow; }
});

test("permissions on the Fraud Checker's courier lookup: customers, deactivated admins and anonymous callers are refused and no courier is called", async () => {
  for (const adminId of ["cust-9", "adm-off", "nobody", null]) await assert.rejects(adminCheckProvider({ adminId, phone: PHONE, provider: "steadfast", fresh: true }), /not authorised|authoris/i, String(adminId));
  assert.equal(calls.length, 0);
  assert.equal((db as any).rateBuckets.size, 0);
  await assert.rejects(checkCourierProviderAction({ phone: PHONE, provider: "steadfast" }), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "cust-9" }, () => checkCourierProviderAction({ phone: PHONE, provider: "steadfast" })), /FORBIDDEN/);
  assert.deepEqual((await runAs("admin", () => checkCourierProviderAction({ phone: PHONE, provider: "steadfast" }))).success, true);
});

test("the order recheck: admin only, one shared-service lookup per courier, and rate limited to 20 per admin per hour (the 60 s order cooldown also applies)", async () => {
  records.set(PHONE, { delivered: 8, cancelled: 2 });
  const o = await place();
  await assert.rejects(recheckFraudAction({ orderId: o.id }), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "cust-9" }, () => recheckFraudAction({ orderId: o.id })), /FORBIDDEN/);
  assert.equal(audits("FRAUD_RECHECK").length, 0);
  // The checkout lookup is "a moment ago" (the 60 s order cooldown would refuse a recheck): age it, as five minutes of real time would.
  const snap = db.get("order", o.id).trustSnapshot as any;
  db.patch("order", o.id, { trustSnapshot: { ...snap, fraudCheck: { ...snap.fraudCheck, checkedAt: new Date(Date.now() - 300_000).toISOString() } } });
  calls = [];
  const first = await runAs("admin", () => recheckFraudAction({ orderId: o.id }));
  assert.equal(first.success, true);
  assert.equal(calls.length, 1, "one fresh lookup through the shared service (the courier that can be asked)");
  const rows = db.rows("courierIntelligenceSnapshot").filter((r) => r.source === "ORDER_RECHECK");
  assert.deepEqual(rows.map((r) => r.provider), ["steadfast"], "the recheck's result is saved as new evidence");
  // a second click within the cooldown is refused (and calls nobody)
  const again = await runAs("admin", () => recheckFraudAction({ orderId: o.id }));
  assert.deepEqual([again.success, (again as any).message?.includes("checked a moment ago")], [false, true]);
  assert.equal(calls.length, 1);
  // keep clicking: the hourly budget (20) is eventually what refuses
  let last: any;
  for (let i = 0; i < 25; i++) last = await runAs("admin", () => recheckFraudAction({ orderId: o.id }));
  assert.match(last.message, /Too many attempts/);
  assert.equal(calls.length, 1, "nothing after the first click reached a courier");
  assert.equal(audits("FRAUD_RECHECK").length, 1);
});

test("a recheck by a deactivated admin is refused inside the service and changes nothing", async () => {
  const o = await place();
  const { recheckOrderFraud } = await import("@/server/services/advance.service");
  calls = [];
  const before = JSON.stringify(db.get("order", o.id).trustSnapshot);
  await assert.rejects(recheckOrderFraud({ orderId: o.id, adminId: "adm-off" }), /not authorised|authoris/i);
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(db.get("order", o.id).trustSnapshot), before);
});
