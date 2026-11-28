/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { drainAfter, discardAfter, emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog, TEST_ADMIN } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder, toCustomerOrder } from "@/server/services/order.service";
import { evaluateOrderRisk } from "@/server/services/fraud-risk.service";
import { reviewRiskOrder } from "@/server/services/fraud-review.service";
import { addRiskListEntry, disableRiskListEntry, listRiskEntries, matchRiskLists, MAX_IP_BLOCK_DAYS } from "@/server/services/risk-list.service";
import { getCustomerRiskProfile } from "@/server/services/customer-risk.service";
import { getQueueCounts, getReviewQueue, getRiskReports } from "@/server/services/fraud-report.service";
import { normalizeBdPhone } from "@/lib/fraud/identity";
import { ORDER_INTERNAL_FIELDS } from "@/lib/order-visibility";

const realEnv = { ...process.env };
let db: FakeDb;
let seq = 0;
const NOW = new Date("2026-11-20T10:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const errorLogs: unknown[][] = [];
const realConsoleError = console.error;

beforeEach(() => {
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.patch("product", "p-standard", { stock: 1000 });
  process.env.RATE_LIMIT_ENABLED = "false"; delete process.env.META_CONVERSIONS_API_TOKEN; delete process.env.GA4_API_SECRET;
  errorLogs.length = 0; console.error = (...a: unknown[]) => { errorLogs.push(a); }; discardAfter();
});
afterEach(() => { console.error = realConsoleError; process.env = { ...realEnv }; discardAfter(); assert.deepEqual(errorLogs, [], "no server error may be logged during a test"); });

function history(o: { phone?: string; email?: string | null; status?: string; events?: string[]; at?: Date; total?: number; userId?: string | null; decision?: string | null; level?: string | null; reviewedLevel?: string | null; reviewedAt?: Date | null; required?: boolean }) {
  const id = `h-${++seq}`;
  const phone = o.phone ?? "01711000000";
  db.insert("order", {
    id, orderNumber: `GP-H${seq}`, channelId: "channel_website", status: o.status ?? "DELIVERED", phone, phoneNorm: normalizeBdPhone(phone) ?? "-", email: o.email ?? null, emailNorm: o.email ?? null,
    userId: o.userId ?? null, total: o.total ?? 500, createdAt: o.at ?? daysAgo(30), shippingSnapshot: {}, riskLevel: o.level ?? null, riskScore: o.level ? 70 : null,
    riskReviewDecision: o.decision ?? null, riskReviewedLevel: o.reviewedLevel ?? null, riskReviewedAt: o.reviewedAt ?? null, riskReviewRequired: o.required ?? false,
  });
  for (const [i, s] of (o.events ?? []).entries()) db.insert("orderTrackingEvent", { id: `${id}-e${i}`, orderId: id, status: s, createdAt: o.at ?? daysAgo(30) });
  return id;
}
async function placed(over: { phone?: string; email?: string; userId?: string } = {}) {
  const userId = over.userId ?? "cust";
  await runAs({ sub: userId }, () => addItemToCart({ productId: "p-standard", variantId: null, quantity: 1 }));
  const phone = over.phone ?? "+8801711000000";
  return runAs({ sub: userId }, () => placeOrder({ ...emptyCheckout, phone, email: over.email ?? "buyer@example.com", shippingAddress: { ...emptyCheckout.shippingAddress, phone } }));
}

// ================================================================================================ block / allow lists
test("block list: matching is on the NORMALISED value; reason, admin and time are recorded; the action is audited", async () => {
  const e = await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "+880 1711-000000", reason: "three refused parcels", adminId: "a1" }, { now: NOW });
  assert.equal(e.value, "01711000000");
  assert.equal(e.displayValue, "+880 1711-000000");
  assert.deepEqual([e.createdById, e.reason], ["a1", "three refused parcels"]);
  assert.ok(e.createdAt);
  for (const phone of ["01711000000", "+8801711000000", "8801711000000", "(01711) 000-000"]) {
    assert.equal((await matchRiskLists({ phones: [normalizeBdPhone(phone)!], email: null, ip: null }, { now: NOW })).blocked.phone, true, phone);
  }
  assert.equal((await matchRiskLists({ phones: ["01811000000"], email: null, ip: null }, { now: NOW })).blocked.phone, false);
  const audit = db.rows("adminAuditEvent").find((a) => a.action === "RISK_LIST_ADDED")!;
  assert.deepEqual([audit.actorId, audit.entityId, (audit.detail as any).reason], ["a1", e.id, "three refused parcels"]);
});

test("e-mail entries match their normalised form (Gmail dots / +tags); IPv6 entries match the whole /64; other providers are not merged", async () => {
  await addRiskListEntry({ listType: "BLOCK", kind: "EMAIL", value: "Bad.Actor+1@Gmail.com", reason: "chargeback fraud", adminId: "a1" }, { now: NOW });
  const m = (email: string) => matchRiskLists({ phones: [], email, ip: null }, { now: NOW });
  assert.equal((await m("badactor@gmail.com")).blocked.email, true);
  assert.equal((await m("bad.actor@googlemail.com")).blocked.email, true);
  assert.equal((await m("badactor@example.com")).blocked.email, false);
  await addRiskListEntry({ listType: "BLOCK", kind: "IP", value: "2001:db8:abcd:12::5", reason: "card testing burst", expiresAt: hours(24), adminId: "a1" }, { now: NOW });
  const ip = (v: string) => matchRiskLists({ phones: [], email: null, ip: v }, { now: NOW });
  assert.equal((await ip("2001:db8:abcd:12:ffff::1")).blocked.ip, true);
  assert.equal((await ip("2001:db8:abcd:13::1")).blocked.ip, false);
});

test("validation: a reason is mandatory, values must be valid, only an active admin may change a list, duplicates are refused", async () => {
  const base = { listType: "BLOCK" as const, kind: "PHONE" as const, value: "01711000000", adminId: "a1" };
  await assert.rejects(addRiskListEntry({ ...base, reason: "" }), /reason/);
  await assert.rejects(addRiskListEntry({ ...base, reason: "abc" }), /reason/);
  await assert.rejects(addRiskListEntry({ ...base, reason: "valid reason", value: "12345" }), /Bangladesh mobile/);
  await assert.rejects(addRiskListEntry({ ...base, kind: "EMAIL", reason: "valid reason", value: "nope" }), /e-mail/);
  await assert.rejects(addRiskListEntry({ ...base, kind: "IP", reason: "valid reason", value: "999.1.1.1", expiresAt: hours(5) }), /IP address/);
  db.insert("user", { id: "c1", email: "c@x.test", name: "c", role: "CUSTOMER", isActive: true });
  for (const adminId of ["c1", "nobody", null]) await assert.rejects(addRiskListEntry({ ...base, reason: "valid reason", adminId: adminId as never }));
  assert.equal(db.rows("riskListEntry").length, 0);
  await addRiskListEntry({ ...base, reason: "valid reason" }, { now: NOW });
  await assert.rejects(addRiskListEntry({ ...base, value: "+8801711000000", reason: "again" }, { now: NOW }), /already on the block list/);
});

test("expiry: an entry with an expiry date stops matching when it passes, shows as EXPIRED, and a past expiry is refused", async () => {
  await assert.rejects(addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "valid reason", expiresAt: hours(-1), adminId: "a1" }, { now: NOW }), /future/);
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "temporary hold", expiresAt: hours(2), adminId: "a1" }, { now: NOW });
  const at = (now: Date) => matchRiskLists({ phones: ["01711000000"], email: null, ip: null }, { now });
  assert.equal((await at(NOW)).blocked.phone, true);
  assert.equal((await at(hours(1))).blocked.phone, true);
  assert.equal((await at(hours(3))).blocked.phone, false);
  assert.equal((await listRiskEntries({ includeInactive: true }, { now: hours(3) }))[0].status, "EXPIRED");
  assert.equal((await listRiskEntries({}, { now: hours(3) })).length, 0, "expired entries are hidden unless asked for");
  assert.equal(db.rows("riskListEntry").length, 1, "never deleted");
});

test("disabling: needs a reason, stops matching immediately, records who/when/why, is audited, keeps the row; the value can be listed again afterwards", async () => {
  const e = await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "suspected fraud", adminId: "a1" }, { now: NOW });
  await assert.rejects(disableRiskListEntry({ id: e.id, reason: "", adminId: "a2" }), /reason/);
  await disableRiskListEntry({ id: e.id, reason: "customer verified, mistake", adminId: "a2" }, { now: hours(1) });
  assert.equal((await matchRiskLists({ phones: ["01711000000"], email: null, ip: null }, { now: hours(1) })).blocked.phone, false);
  const row = db.get("riskListEntry", e.id);
  assert.deepEqual([row.disabledById, row.disabledReason], ["a2", "customer verified, mistake"]);
  assert.ok(row.disabledAt);
  assert.ok(db.rows("adminAuditEvent").some((a) => a.action === "RISK_LIST_DISABLED" && a.actorId === "a2"));
  await assert.rejects(disableRiskListEntry({ id: e.id, reason: "again", adminId: "a2" }), /already disabled/);
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "fresh evidence", adminId: "a1" }, { now: hours(2) });
  assert.equal(db.rows("riskListEntry").length, 2);
});

test("IP blocks are conservative: they MUST expire and for at most 90 days; nothing is ever added to a list automatically", async () => {
  const ip = { listType: "BLOCK" as const, kind: "IP" as const, value: "203.0.113.50", reason: "card testing", adminId: "a1" };
  await assert.rejects(addRiskListEntry(ip, { now: NOW }), /must expire/);
  await assert.rejects(addRiskListEntry({ ...ip, expiresAt: daysAgo(-(MAX_IP_BLOCK_DAYS + 1)) }, { now: NOW }), /at most 90 days/);
  await addRiskListEntry({ ...ip, expiresAt: daysAgo(-30) }, { now: NOW });
  // Heavy bad history and many evaluations never create a block by themselves.
  for (let i = 0; i < 6; i++) history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] });
  const o = await placed();
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: "203.0.113.99", now: NOW });
  assert.equal(db.rows("riskListEntry").length, 1);
});

test("an IP block alone holds an order for REVIEW (HIGH) but never rejects or cancels it; a phone block holds it as CRITICAL", async () => {
  await addRiskListEntry({ listType: "BLOCK", kind: "IP", value: "203.0.113.50", reason: "card testing", expiresAt: hours(48), adminId: "a1" }, { now: NOW });
  const o = await placed();
  const r = (await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: "203.0.113.50", now: NOW }))!;
  assert.deepEqual([r.level, r.score], ["HIGH", 60]);
  assert.equal(db.get("order", o.id).status, "PENDING");
  const q = await placed({ userId: "q", phone: "+8801711000020", email: "q@example.com" });
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000020", reason: "refused 3 parcels", adminId: "a1" }, { now: NOW });
  assert.equal((await evaluateOrderRisk(q.id, { trigger: "CHECKOUT", now: NOW }))!.level, "CRITICAL");
  assert.equal(db.get("order", q.id).status, "PENDING", "held, not cancelled");
});

test("allow list: lowers the score, never offsets a block, and never bypasses advance verification or the low-trust review", async () => {
  for (let i = 0; i < 3; i++) history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] }); // 45
  const o = await placed();
  assert.equal((await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", now: NOW }))!.score, 45);
  await addRiskListEntry({ listType: "ALLOW", kind: "PHONE", value: "01711000000", reason: "long-standing VIP customer", adminId: "a1" }, { now: NOW });
  const r = (await evaluateOrderRisk(o.id, { trigger: "RECALC", now: NOW }))!;
  assert.equal(r.score, 15);
  // ...but the existing mandatory checks are exactly as before:
  db.patch("order", o.id, { advanceRequired: 200, advancePaid: 0, trustReviewRequired: true });
  await assert.rejects(adminUpdateOrderStatus(o.id, "CONFIRMED" as never, undefined, TEST_ADMIN), /advance/i);
  db.patch("order", o.id, { advancePaid: 200 });
  await assert.rejects(adminUpdateOrderStatus(o.id, "CONFIRMED" as never, undefined, TEST_ADMIN), /staff review/);
  // ...and a block wins over the allow entry.
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "now confirmed fraudster", adminId: "a1" }, { now: NOW });
  const b = (await evaluateOrderRisk(o.id, { trigger: "RECALC", now: NOW }))!;
  assert.equal(b.level, "CRITICAL");
  const sig = ((db.rows("orderRiskAssessment").at(-1)!.signals as any).signals as any[]).map((s) => s.code);
  assert.ok(!sig.includes("ALLOW_PHONE"));
});

test("list search and filters work on the normalised value", async () => {
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "fraud ring", adminId: "a1" }, { now: NOW });
  await addRiskListEntry({ listType: "ALLOW", kind: "EMAIL", value: "vip@example.com", reason: "known customer", adminId: "a1" }, { now: NOW });
  assert.equal((await listRiskEntries({ listType: "BLOCK" }, { now: NOW })).length, 1);
  assert.equal((await listRiskEntries({ search: "+8801711000000" }, { now: NOW })).length, 1);
  assert.equal((await listRiskEntries({ kind: "EMAIL" }, { now: NOW }))[0].displayValue, "vip@example.com");
});

// ================================================================================================ customer profile
test("customer profile: counts, rates and values are computed from the real orders; refused COD is reported as NOT recorded", async () => {
  history({ status: "DELIVERED", events: ["CONFIRMED", "DELIVERED"], total: 500 });
  history({ status: "DELIVERED", events: ["CONFIRMED", "DELIVERED"], total: 700 });
  history({ status: "CANCELLED", events: [], total: 300 });
  history({ status: "FAILED_DELIVERY", events: ["CONFIRMED", "FAILED_DELIVERY"], total: 900 });
  history({ status: "CANCELLED", events: [], decision: "REJECTED", level: "CRITICAL", total: 400 });
  history({ status: "PENDING", events: [], total: 100, level: "HIGH", decision: "APPROVED", reviewedLevel: "HIGH", reviewedAt: daysAgo(1) });
  const p = (await getCustomerRiskProfile({ phone: "+880 1711 000000" }, { now: NOW }))!;
  assert.deepEqual(p.identity.phones, ["01711000000"]);
  const s = p.stats;
  assert.deepEqual([s.total, s.confirmed, s.delivered, s.cancelled, s.failedDelivery], [6, 3, 2, 2, 1]);
  assert.equal(s.successfulValue, 1200);
  assert.equal(s.cancellationRate, 0.333);
  assert.equal(s.failedDeliveryRate, 0.333);
  assert.deepEqual([s.fraudRejected, s.criticalRisk, s.highRisk, s.overriddenApprovals], [1, 1, 1, 1]);
  assert.equal(s.refusedCod, null);
  assert.equal(p.truncated, false);
  assert.equal(p.recentOrders.length, 6);
});

test("a guest is found by normalised phone or e-mail (any spelling), a signed-in customer by account; ANOTHER customer's data never appears", async () => {
  history({ phone: "01711000000", email: "me@example.com", status: "DELIVERED", events: ["DELIVERED"] });
  history({ phone: "+8801711000000", email: null, status: "DELIVERED", events: ["DELIVERED"] });
  history({ phone: "01899999999", email: "me@example.com", status: "CANCELLED", events: [] });
  history({ phone: "01822222222", email: "other@example.com", status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"], total: 99999 });
  history({ phone: "01833333333", email: null, status: "DELIVERED", events: ["DELIVERED"], userId: "acct-1" });
  assert.equal((await getCustomerRiskProfile({ phone: "8801711000000" }, { now: NOW }))!.stats.total, 2);
  assert.equal((await getCustomerRiskProfile({ email: "ME@example.com" }, { now: NOW }))!.stats.total, 2);
  const both = (await getCustomerRiskProfile({ phone: "01711000000", email: "me@example.com" }, { now: NOW }))!;
  assert.equal(both.stats.total, 3);
  assert.ok(!JSON.stringify(both).includes("other@example.com") && !JSON.stringify(both).includes("01822222222") && both.stats.failedDelivery === 0);
  assert.equal((await getCustomerRiskProfile({ userId: "acct-1" }, { now: NOW }))!.stats.total, 1);
  assert.equal(await getCustomerRiskProfile({}, { now: NOW }), null);
  assert.equal(await getCustomerRiskProfile({ phone: "garbage" }, { now: NOW }), null);
});

test("the profile includes the score history, recurring signals and active list entries for the customer", async () => {
  for (let i = 0; i < 2; i++) history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] });
  const a = await placed();
  await evaluateOrderRisk(a.id, { trigger: "CHECKOUT", now: NOW });
  await addRiskListEntry({ listType: "ALLOW", kind: "PHONE", value: "01711000000", reason: "ok customer", adminId: "a1" }, { now: NOW });
  await evaluateOrderRisk(a.id, { trigger: "RECALC", now: hours(1) });
  const p = (await getCustomerRiskProfile({ orderId: a.id }, { now: hours(1) }))!;
  assert.deepEqual(p.scoreHistory.map((h) => h.score).sort((x, y) => x - y), [0, 30]);
  assert.equal(p.currentRisk!.score, 0);
  assert.ok(p.activeListEntries.some((e) => e.listType === "ALLOW"));
  const p2 = (await getCustomerRiskProfile({ phone: "01711000000" }, { now: hours(1) }))!;
  assert.ok(Array.isArray(p2.signals));
});

test("customers can never see risk data: every new column is on the hidden list and absent from the customer view of an order", async () => {
  const o = await placed();
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: "203.0.113.7", now: NOW });
  const added = ["phoneNorm", "emailNorm", "addressKey", "checkoutKey", "riskScore", "riskLevel", "riskAssessedAt", "riskAssessmentId", "riskReviewRequired", "riskReviewDecision", "riskReviewedLevel", "riskReviewedById", "riskReviewedAt", "riskReviewReason"];
  for (const f of added) assert.ok((ORDER_INTERNAL_FIELDS as readonly string[]).includes(f), `${f} must be hidden from customers`);
  const view = toCustomerOrder({ ...db.get("order", o.id), items: [] } as never) as Record<string, unknown>;
  for (const f of added) assert.ok(!(f in view), `${f} leaked to the customer view`);
  assert.ok(!JSON.stringify(view).includes("203.0.113.7"));
});

// ================================================================================================ queue + reports
test("review queue: filtered by level and state, searchable by order number / phone (any format) / e-mail; counts match", async () => {
  const hi = history({ phone: "01711000001", email: "hi@example.com", status: "PENDING", level: "HIGH", required: true, at: daysAgo(1) });
  const cr = history({ phone: "01711000002", status: "PENDING", level: "CRITICAL", required: true, at: daysAgo(1) });
  history({ phone: "01711000003", status: "PENDING", level: "MEDIUM", at: daysAgo(1) });
  history({ phone: "01711000004", status: "PENDING", level: "HIGH", required: true, decision: "APPROVED", reviewedLevel: "HIGH", reviewedAt: daysAgo(0), at: daysAgo(1) });
  assert.deepEqual(await getQueueCounts(), { high: 1, critical: 1, total: 2 });
  const q = await getReviewQueue({});
  assert.deepEqual(q.rows.map((r) => r.id).sort(), [cr, hi].sort());
  assert.equal(q.rows[0].riskScore! >= q.rows[1].riskScore!, true);
  assert.deepEqual((await getReviewQueue({ levels: ["CRITICAL"] })).rows.map((r) => r.id), [cr]);
  assert.equal((await getReviewQueue({ state: "reviewed" })).rows.length, 1);
  assert.equal((await getReviewQueue({ search: "+880 1711-000001" })).rows[0].id, hi);
  assert.equal((await getReviewQueue({ search: "HI@example" })).rows[0].id, hi);
  assert.equal((await getReviewQueue({ search: db.get("order", cr).orderNumber as string })).rows[0].id, cr);
  assert.equal((await getReviewQueue({ search: "nothing-matches" })).rows.length, 0);
});

test("reports use real data: orders by level, the high-risk trend, repeat cancellations / failed deliveries / repeated activity, review outcomes and overrides", async () => {
  const from = daysAgo(6), to = NOW;
  history({ phone: "01711000001", status: "CANCELLED", level: "HIGH", at: daysAgo(2) });
  history({ phone: "01711000001", status: "CANCELLED", level: "CRITICAL", at: daysAgo(2) });
  history({ phone: "01711000001", status: "FAILED_DELIVERY", level: "HIGH", events: ["FAILED_DELIVERY"], at: daysAgo(1) });
  history({ phone: "01711000001", status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"], level: "LOW", at: daysAgo(1) });
  history({ phone: "01811000009", status: "DELIVERED", level: "MEDIUM", at: daysAgo(3) });
  history({ phone: "01711000050", status: "DELIVERED", level: "HIGH", decision: "APPROVED", reviewedLevel: "HIGH", reviewedAt: daysAgo(2), events: ["DELIVERED"], at: daysAgo(3) });
  history({ phone: "01711000051", status: "FAILED_DELIVERY", level: "CRITICAL", decision: "APPROVED", reviewedLevel: "CRITICAL", reviewedAt: daysAgo(2), events: ["FAILED_DELIVERY"], at: daysAgo(3) });
  history({ phone: "01711000052", status: "CANCELLED", level: "HIGH", decision: "REJECTED", reviewedLevel: "HIGH", reviewedAt: daysAgo(2), at: daysAgo(3) });
  history({ phone: "01711000053", status: "DELIVERED", at: daysAgo(40) }); // outside the window
  const r = await getRiskReports({ from, to });
  assert.deepEqual(r.byLevel, { LOW: 1, MEDIUM: 1, HIGH: 4, CRITICAL: 2, UNASSESSED: 0 });
  assert.equal(r.trend.length, 7);
  assert.equal(r.trend.reduce((n, d) => n + d.high + d.critical, 0), 6);
  assert.equal(r.trend.find((d) => d.date === daysAgo(2).toISOString().slice(0, 10))!.critical, 1);
  assert.deepEqual(r.repeatCancellations.map((x) => [x.phone, x.count]), [["0171****001", 2]]);
  assert.ok(r.failedDeliveryPatterns.some((x) => x.phone === "0171****001" && x.count === 2));
  assert.ok(r.repeatedActivity.phones.some((x) => x.phone === "0171****001" && x.count >= 4));
  assert.ok(!JSON.stringify(r).includes("01711000001"), "numbers are masked in reports");
  assert.deepEqual(r.reviewOutcomes, { approved: 2, rejected: 1, pending: 0 });
  assert.deepEqual(r.overrides, { total: 2, delivered: 1, failedDelivery: 1, cancelled: 0, inProgress: 0, deliveredShare: 0.5 });
  assert.equal(r.truncated, false);
  assert.ok(r.notes.some((n) => /Refused COD/.test(n)));
});

test("reports on an empty database are honest zeros, not invented numbers", async () => {
  const r = await getRiskReports({ from: daysAgo(6), to: NOW });
  assert.deepEqual(r.byLevel, { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNASSESSED: 0 });
  assert.ok(r.trend.every((d) => d.high === 0 && d.critical === 0));
  assert.deepEqual([r.repeatCancellations, r.failedDeliveryPatterns, r.repeatedActivity.phones], [[], [], []]);
  assert.deepEqual(r.overrides, { total: 0, delivered: 0, failedDelivery: 0, cancelled: 0, inProgress: 0, deliveredShare: null });
  assert.deepEqual(await getQueueCounts(), { high: 0, critical: 0, total: 0 });
});

test("false-positive handling: approving a HIGH order and seeing it delivered is recorded as an override that turned out fine; a later escalation does not erase the review record", async () => {
  for (let i = 0; i < 3; i++) history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] });
  for (let i = 0; i < 3; i++) history({ status: "CANCELLED", events: [] });
  const o = await placed();
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", now: NOW });
  await reviewRiskOrder({ orderId: o.id, adminId: "a1", decision: "APPROVED", reason: "Customer is a known repeat buyer.", assessmentId: db.get("order", o.id).riskAssessmentId as string }, { now: NOW });
  await adminUpdateOrderStatus(o.id, "CONFIRMED" as never, undefined, TEST_ADMIN);
  await drainAfter();
  for (const s of ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) await adminUpdateOrderStatus(o.id, s as never, undefined, TEST_ADMIN);
  const r = await getRiskReports({ from: daysAgo(1), to: hours(24) });
  assert.equal(r.overrides.total, 1);
  assert.equal(r.overrides.delivered, 1);
  assert.equal(r.overrides.deliveredShare, 1);
  assert.equal(db.get("order", o.id).riskReviewDecision, "APPROVED");
});
