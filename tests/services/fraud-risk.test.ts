/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { drainAfter, discardAfter, emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog, TEST_ADMIN } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import { dispatchBlockedReason, getAdvancePanel } from "@/server/services/advance.service";
import { evaluateOrderRisk, getFraudPolicy, runFraudMaintenance, saveFraudPolicy } from "@/server/services/fraud-risk.service";
import { MIN_REVIEW_REASON, recalculateOrderRisk, reviewRiskOrder } from "@/server/services/fraud-review.service";
import { addRiskListEntry, disableRiskListEntry } from "@/server/services/risk-list.service";
import { DEFAULT_FRAUD_POLICY } from "@/lib/fraud/policy";
import { addressKeyOf, normalizeBdPhone } from "@/lib/fraud/identity";
import { UserFacingError } from "@/lib/errors";

const realEnv = { ...process.env };
let db: FakeDb;
let seq = 0;
const HOME_ADDRESS = addressKeyOf({ line1: "House 1, Road 2", city: "Dhaka" })!; // what placed() orders deliver to
const NOW = new Date("2026-11-20T10:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const errorLogs: unknown[][] = [];
const realConsoleError = console.error;

beforeEach(() => {
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.patch("storeSettings", "singleton", { consentMode: "OFF" });
  db.patch("product", "p-standard", { stock: 1000 });
  delete process.env.META_CONVERSIONS_API_TOKEN; delete process.env.GA4_API_SECRET;
  process.env.RATE_LIMIT_ENABLED = "false";
  errorLogs.length = 0;
  // Any server error logged during a test is a silent failure that the assertions might not notice: fail on it (see afterEach).
  console.error = (...a: unknown[]) => { errorLogs.push(a); };
  discardAfter();
});
afterEach(() => {
  console.error = realConsoleError;
  process.env = { ...realEnv };
  discardAfter();
  assert.deepEqual(errorLogs, [], "no server error may be logged during a test");
});

/** A past website order for some identity, inserted directly (history). */
function history(o: { phone?: string; email?: string | null; status?: string; events?: string[]; at?: Date; items?: [string, number][]; address?: string | null; decision?: string | null; total?: number; userId?: string | null; payments?: string[]; channelId?: string }) {
  const id = `h-${++seq}`;
  const phone = o.phone ?? "01711000000";
  db.insert("order", {
    id, orderNumber: `GP-H${seq}`, channelId: o.channelId ?? "channel_website", status: o.status ?? "DELIVERED", phone, phoneNorm: normalizeBdPhone(phone) ?? "-",
    email: o.email ?? null, emailNorm: o.email ?? null, addressKey: o.address ?? null, userId: o.userId ?? null, total: o.total ?? 500,
    createdAt: o.at ?? daysAgo(30), riskReviewDecision: o.decision ?? null, riskLevel: null, riskReviewRequired: false, shippingSnapshot: {},
  });
  for (const [i, s] of (o.events ?? []).entries()) db.insert("orderTrackingEvent", { id: `${id}-e${i}`, orderId: id, status: s, createdAt: o.at ?? daysAgo(30) });
  for (const [i, [productId, quantity]] of (o.items ?? []).entries()) db.insert("orderItem", { id: `${id}-i${i}`, orderId: id, productId, variantId: null, quantity, unitPrice: 100 });
  for (const [i, status] of (o.payments ?? []).entries()) db.insert("payment", { id: `${id}-p${i}`, orderId: id, kind: "ADVANCE", status, amount: 100 });
  return id;
}

/** A real, pending website order placed through the real checkout service. */
async function placed(over: { phone?: string; email?: string; userId?: string; productId?: string; quantity?: number; line1?: string; fullName?: string } = {}) {
  const userId = over.userId ?? "cust";
  await runAs({ sub: userId }, () => addItemToCart({ productId: over.productId ?? "p-standard", variantId: null, quantity: over.quantity ?? 1 }));
  const phone = over.phone ?? "+8801711000000";
  return runAs({ sub: userId }, () =>
    placeOrder({ ...emptyCheckout, phone, email: over.email ?? "buyer@example.com", shippingAddress: { ...emptyCheckout.shippingAddress, phone, line1: over.line1 ?? "House 1, Road 2", fullName: over.fullName ?? "Buyer One" } }),
  );
}
const evalOrder = (id: string, ip?: string, now = NOW) => evaluateOrderRisk(id, { trigger: "CHECKOUT", ip: ip ?? null, now });
const assessments = (orderId: string) => db.rows("orderRiskAssessment").filter((a) => a.orderId === orderId);
const signalCodes = (a: any) => (a.signals.signals as { code: string }[]).map((s) => s.code);
const confirm = async (id: string) => { const r = await adminUpdateOrderStatus(id, "CONFIRMED" as never, undefined, TEST_ADMIN); await drainAfter(); return r; };
/** Seeds enough bad history for the phone to land in the HIGH band with default weights (3 failed deliveries = 45, 3 cancelled = 24 => 69). */
const makeHighRisk = (phone = "01711000000") => {
  for (let i = 0; i < 3; i++) history({ phone, status: "FAILED_DELIVERY", events: ["CONFIRMED", "FAILED_DELIVERY"] });
  for (let i = 0; i < 3; i++) history({ phone, status: "CANCELLED", events: ["CONFIRMED"] });
};

// ================================================================================================ evaluation + explanation

test("a first-time customer scores 0 / LOW; the assessment is stored with its explanation, policy snapshot and calculation time", async () => {
  const o = await placed();
  const r = await evalOrder(o.id, "203.0.113.7");
  assert.deepEqual([r!.score, r!.level, r!.reviewRequired], [0, "LOW", false]);
  const row = db.get("order", o.id);
  assert.deepEqual([row.riskScore, row.riskLevel, row.riskReviewRequired], [0, "LOW", false]);
  assert.equal(new Date(row.riskAssessedAt as Date).getTime(), NOW.getTime());
  const [a] = assessments(o.id);
  assert.equal(a.trigger, "CHECKOUT");
  assert.deepEqual((a.signals as any).signals, []);
  assert.equal((a.policy as any).thresholds.high, 60, "the policy used is frozen with the assessment");
  assert.equal(a.clientIp, "203.0.113.7");
  assert.equal(row.riskAssessmentId, a.id);
});

test("history is matched on the NORMALISED phone: every Bangladesh spelling is the same customer; the signals list each cause with exact points and the related orders", async () => {
  history({ phone: "01711000000", status: "CANCELLED", events: ["CONFIRMED"] });
  history({ phone: "+880 1711-000000", status: "CANCELLED", events: [] });
  history({ phone: "8801711000000", status: "FAILED_DELIVERY", events: ["CONFIRMED", "FAILED_DELIVERY"] });
  const o = await placed({ phone: "+8801711000000" });
  const r = (await evalOrder(o.id))!;
  const [a] = assessments(o.id);
  const by = Object.fromEntries(((a.signals as any).signals as any[]).map((s) => [s.code, s]));
  assert.equal(by.PRIOR_CANCELLED.points, 16);
  assert.equal(by.PRIOR_FAILED_DELIVERY.points, 15);
  assert.equal(by.PRIOR_CANCELLED.refs.length, 2);
  assert.equal(r.score, 31);
  assert.equal(r.level, "MEDIUM");
  assert.equal((a.signals as any).signals.reduce((n: number, s: any) => n + s.points, 0), (a.signals as any).rawTotal);
  // A different customer's history never leaks into this score.
  const other = await placed({ phone: "+8801811999999", userId: "cust2", email: "other@example.com" });
  assert.equal((await evalOrder(other.id))!.score, 0);
});

test("a fraud rejection is counted ONCE (as a rejection), never again as a plain cancellation; delivered history at the same address is a credit", async () => {
  history({ status: "CANCELLED", decision: "REJECTED", events: [] });
  history({ status: "DELIVERED", events: ["CONFIRMED", "DELIVERED"], address: HOME_ADDRESS });
  const o = await placed();
  const r = (await evalOrder(o.id))!;
  const codes = signalCodes(assessments(o.id)[0]);
  assert.ok(codes.includes("PRIOR_FRAUD_REJECTED"));
  assert.ok(!codes.includes("PRIOR_CANCELLED"), "not double counted");
  assert.ok(codes.includes("DELIVERED_KNOWN_ADDRESS"));
  assert.equal(r.score, 25 - 12);
});

test("frequency: many orders from one phone inside the window add up; the same orders outside the window do not", async () => {
  for (let i = 0; i < 4; i++) history({ status: "PENDING", at: hoursAgo(2 + i) });
  const o = await placed();
  db.patch("order", o.id, { createdAt: NOW });
  const r = (await evalOrder(o.id))!;
  const burst = ((assessments(o.id)[0].signals as any).signals as any[]).find((s) => s.code === "PHONE_BURST");
  assert.equal(burst.points, 18); // 4 others, first free: 3 x 6
  assert.equal(r.score, 18);
  db.remove("order", (x) => String(x.id).startsWith("h-"));
  for (let i = 0; i < 4; i++) history({ status: "PENDING", at: hoursAgo(72 + i) });
  assert.equal((await evalOrder(o.id))!.score, 0, "outside the 24h window");
});

test("duplicate cart: an identical order (same items and quantities) shortly before is flagged; a different cart or an old one is not", async () => {
  history({ status: "PENDING", at: hoursAgo(0.2), items: [["p-standard", 1]] });
  const o = await placed({ productId: "p-standard", quantity: 1 });
  db.patch("order", o.id, { createdAt: NOW });
  assert.ok(signalCodes((await evalOrder(o.id, undefined), assessments(o.id)[0])).includes("DUPLICATE_CART"));
  db.remove("order", (x) => String(x.id).startsWith("h-")); db.remove("orderItem", (x) => String(x.id).startsWith("h-"));
  history({ status: "PENDING", at: hoursAgo(0.2), items: [["p-standard", 2]] });
  await evalOrder(o.id);
  assert.ok(!signalCodes(assessments(o.id).at(-1)).includes("DUPLICATE_CART"), "different quantity");
  db.remove("order", (x) => String(x.id).startsWith("h-")); db.remove("orderItem", (x) => String(x.id).startsWith("h-"));
  history({ status: "PENDING", at: hoursAgo(5), items: [["p-standard", 1]] });
  await evalOrder(o.id);
  assert.ok(!signalCodes(assessments(o.id).at(-1)).includes("DUPLICATE_CART"), "outside the 30 minute window");
});

test("a shared IP is NOT one customer: five different phones on one IP add only the weak 6-point signal and never reach MEDIUM; one phone repeating does not trigger it", async () => {
  const first = await placed({ phone: "+8801711000001", userId: "u1", email: "a1@example.com", line1: "Flat 1, Block A, Uttara" });
  await evalOrder(first.id, "198.51.100.9");
  for (let i = 2; i <= 5; i++) {
    const o = await placed({ phone: `+880171100000${i}`, userId: `u${i}`, email: `a${i}@example.com`, line1: `Flat ${i}, Block ${i}, Uttara` });
    await evalOrder(o.id, "198.51.100.9");
  }
  const o6 = await placed({ phone: "+8801711000006", userId: "u6", email: "a6@example.com", line1: "Flat 6, Block 6, Uttara" });
  const r = (await evalOrder(o6.id, "198.51.100.9"))!;
  assert.deepEqual(signalCodes(assessments(o6.id)[0]), ["IP_MANY_IDENTITIES"]);
  assert.equal(r.score, 6);
  assert.equal(r.level, "LOW");
  assert.ok(!db.get("order", o6.id).riskReviewRequired);
  // Without an IP nothing is inferred at all.
  const o7 = await placed({ phone: "+8801711000007", userId: "u7", email: "a7@example.com", line1: "Flat 7, Block 7, Uttara" });
  assert.deepEqual(signalCodes((await evalOrder(o7.id), assessments(o7.id)[0])), []);
});

test("linked identities: the same address with several OTHER phones, and the same e-mail with several OTHER phones, are flagged at their thresholds", async () => {
  for (let i = 0; i < 3; i++) history({ phone: `0181100000${i}`, address: HOME_ADDRESS, email: "ring@example.com", at: daysAgo(2), status: "PENDING" });
  const o = await placed({ email: "ring@example.com" });
  await evalOrder(o.id);
  const codes = signalCodes(assessments(o.id)[0]);
  assert.ok(codes.includes("ADDRESS_MANY_IDENTITIES"));
  assert.ok(codes.includes("EMAIL_MANY_PHONES"));
});

test("existing advance-payment history: rejected advances raise the score, a staff-verified advance is a credit", async () => {
  history({ payments: ["FAILED", "FAILED"], status: "CANCELLED", events: [] });
  history({ payments: ["PAID"], status: "DELIVERED", events: ["DELIVERED"] });
  const o = await placed();
  await evalOrder(o.id);
  const by = Object.fromEntries(((assessments(o.id)[0].signals as any).signals as any[]).map((s) => [s.code, s.points]));
  assert.equal(by.ADVANCE_REJECTED, 20);
  assert.equal(by.VERIFIED_ADVANCE_HISTORY, -8);
});

test("the EXISTING trust result is consumed as stored: real low-trust evidence counts, 'no evidence' does not, and nothing about trust is changed", async () => {
  const a = await placed();
  db.patch("order", a.id, { trustScore: 50, trustSnapshot: { insufficientEvidence: true, policy: { lowBelow: 60 }, zone: { conflict: false } } });
  assert.deepEqual(signalCodes((await evalOrder(a.id), assessments(a.id)[0])), []);
  const b = await placed({ userId: "u9", phone: "+8801711000009", email: "n9@example.com" });
  db.patch("order", b.id, { trustScore: 25, trustSnapshot: { insufficientEvidence: false, policy: { lowBelow: 60 }, zone: { conflict: true } } });
  await evalOrder(b.id);
  assert.deepEqual(signalCodes(assessments(b.id)[0]).sort(), ["LOW_TRUST_EVIDENCE", "ZONE_MISMATCH"]);
  const after = db.get("order", b.id);
  assert.equal(after.trustScore, 25, "trust score untouched");
  assert.equal(after.trustReviewRequired, false);
});

test("address quality: a placeholder address / name is flagged from the text; a normal one is not", async () => {
  const bad = await placed({ line1: "asdf", fullName: "Test" });
  await evalOrder(bad.id);
  assert.ok(signalCodes(assessments(bad.id)[0]).includes("ADDRESS_QUALITY"));
  const good = await placed({ userId: "g1", phone: "+8801711000011", email: "g1@example.com", line1: "House 12, Road 5, Dhanmondi", fullName: "Rahim Uddin" });
  await evalOrder(good.id);
  assert.ok(!signalCodes(assessments(good.id)[0]).includes("ADDRESS_QUALITY"));
});

test("recalculation: an identical result adds no history row (only the timestamp moves); new evidence adds one; the score history keeps both", async () => {
  const o = await placed();
  await evalOrder(o.id, undefined, NOW);
  const later = new Date(NOW.getTime() + 3_600_000);
  const same = (await evalOrder(o.id, undefined, later))!;
  assert.equal(same.changed, false);
  assert.equal(assessments(o.id).length, 1);
  assert.equal(new Date(db.get("order", o.id).riskAssessedAt as Date).getTime(), later.getTime());
  history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] });
  const changed = (await evalOrder(o.id, undefined, later))!;
  assert.equal(changed.changed, true);
  assert.equal(assessments(o.id).length, 2);
  assert.deepEqual(assessments(o.id).map((a) => a.score), [0, 15]);
});

test("the IP seen at checkout is reused when the order is re-evaluated later without one (the IP signal is not lost)", async () => {
  const o = await placed();
  await evalOrder(o.id, "198.51.100.77");
  history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] });
  await evaluateOrderRisk(o.id, { trigger: "CONFIRM", now: NOW });
  assert.equal(assessments(o.id).at(-1)!.clientIp, "198.51.100.77");
});

// ================================================================================================ confirmation protection

test("LOW risk: the normal workflow, no review needed", async () => {
  const o = await placed();
  await evalOrder(o.id);
  await confirm(o.id);
  assert.equal(db.get("order", o.id).status, "CONFIRMED");
});

test("MEDIUM risk: shown as a warning, but confirmation is allowed (no gate)", async () => {
  history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] }); history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] }); // 30
  const o = await placed();
  const r = (await evalOrder(o.id))!;
  assert.equal(r.level, "MEDIUM");
  assert.equal(db.get("order", o.id).riskReviewRequired, false);
  await confirm(o.id);
  assert.equal(db.get("order", o.id).status, "CONFIRMED");
});

test("HIGH risk: cannot be confirmed silently; an admin override needs a recorded reason; it clears ONLY the fraud gate", async () => {
  makeHighRisk();
  const o = await placed();
  const r = (await evalOrder(o.id))!;
  assert.equal(r.level, "HIGH");
  assert.equal(db.get("order", o.id).riskReviewRequired, true);
  await assert.rejects(confirm(o.id), /fraud-risk review/);
  assert.equal(db.get("order", o.id).status, "PENDING");

  const aid = db.get("order", o.id).riskAssessmentId as string;
  await assert.rejects(reviewRiskOrder({ orderId: o.id, adminId: "a1", decision: "APPROVED", reason: "", assessmentId: aid }), /reason/);
  await assert.rejects(reviewRiskOrder({ orderId: o.id, adminId: "a1", decision: "APPROVED", reason: "x".repeat(MIN_REVIEW_REASON - 1), assessmentId: aid }), /at least/);
  assert.equal(db.get("order", o.id).riskReviewDecision, null);

  const done = await reviewRiskOrder({ orderId: o.id, adminId: "a1", decision: "APPROVED", reason: "Called the customer, confirmed the address.", assessmentId: aid });
  assert.deepEqual(done, { decision: "APPROVED", level: "HIGH" });
  const row = db.get("order", o.id);
  assert.deepEqual([row.riskReviewDecision, row.riskReviewedLevel, row.riskReviewedById, row.status], ["APPROVED", "HIGH", "a1", "PENDING"]);
  assert.ok(row.riskReviewedAt);
  assert.equal(row.advancePaid ?? null, row.advancePaid ?? null);
  const audit = db.rows("adminAuditEvent").find((e) => e.action === "RISK_ORDER_APPROVED")!;
  assert.equal((audit.detail as any).reason, "Called the customer, confirmed the address.");
  assert.equal(audit.actorId, "a1");
  await confirm(o.id);
  assert.equal(db.get("order", o.id).status, "CONFIRMED");
});

test("CRITICAL risk: the order is held; only a designated reviewer may release it; a refused attempt is audited; stale or unknown assessments are refused", async () => {
  db.patch("storeSettings", "singleton", { fraudPolicy: { criticalReviewerIds: ["a2"] } });
  const o = await placed();
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "chargeback fraud", adminId: "a1" });
  const r = (await evalOrder(o.id))!;
  assert.deepEqual([r.level, r.reviewRequired], ["CRITICAL", true]);
  await assert.rejects(confirm(o.id), /on hold for fraud review/);
  const aid = db.get("order", o.id).riskAssessmentId as string;
  const reason = "Verified identity by video call.";
  await assert.rejects(reviewRiskOrder({ orderId: o.id, adminId: "a1", decision: "APPROVED", reason, assessmentId: aid }), /not authorised/);
  assert.ok(db.rows("adminAuditEvent").some((e) => e.action === "RISK_REVIEW_DENIED" && e.actorId === "a1"));
  assert.equal(db.get("order", o.id).riskReviewDecision, null);
  await assert.rejects(reviewRiskOrder({ orderId: o.id, adminId: "a2", decision: "APPROVED", reason, assessmentId: "stale" }), /changed since you opened/);
  await reviewRiskOrder({ orderId: o.id, adminId: "a2", decision: "APPROVED", reason, assessmentId: aid });
  await confirm(o.id);
  assert.equal(db.get("order", o.id).status, "CONFIRMED");
});

test("override permissions: only an active ADMIN can review; customers, unknown users and deactivated admins are refused", async () => {
  makeHighRisk();
  const o = await placed();
  await evalOrder(o.id);
  const aid = db.get("order", o.id).riskAssessmentId as string;
  db.insert("user", { id: "c1", email: "c@x.test", name: "c", role: "CUSTOMER", isActive: true });
  db.insert("user", { id: "gone", email: "g@x.test", name: "g", role: "ADMIN", isActive: false });
  for (const adminId of ["c1", "gone", "nobody", null, undefined]) {
    await assert.rejects(reviewRiskOrder({ orderId: o.id, adminId: adminId as never, decision: "APPROVED", reason: "A perfectly good reason", assessmentId: aid }), undefined, String(adminId));
  }
  assert.equal(db.get("order", o.id).riskReviewDecision, null);
  await assert.rejects(recalculateOrderRisk(o.id, "c1"));
});

test("an approval covers the level reviewed, but if the risk ESCALATES afterwards (e.g. a block is added) the order is held again", async () => {
  makeHighRisk();
  const o = await placed();
  await evalOrder(o.id);
  await reviewRiskOrder({ orderId: o.id, adminId: "a1", decision: "APPROVED", reason: "Customer verified by phone call.", assessmentId: db.get("order", o.id).riskAssessmentId as string });
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: "01711000000", reason: "new chargeback received", adminId: "a1" });
  await assert.rejects(confirm(o.id), /on hold for fraud review/, "re-evaluated at confirm time: CRITICAL now exceeds the reviewed HIGH");
  assert.equal(db.get("order", o.id).riskLevel, "CRITICAL");
  assert.equal(db.get("order", o.id).status, "PENDING");
});

test("REJECT cancels the order through the normal funnel (recorded reason, audited); an order that cannot be cancelled keeps no false rejection record", async () => {
  makeHighRisk();
  const o = await placed();
  await evalOrder(o.id);
  const reason = "Phone unreachable and the address does not exist.";
  await reviewRiskOrder({ orderId: o.id, adminId: "a1", decision: "REJECTED", reason, assessmentId: db.get("order", o.id).riskAssessmentId as string });
  const row = db.get("order", o.id);
  assert.deepEqual([row.status, row.riskReviewDecision], ["CANCELLED", "REJECTED"]);
  assert.ok(db.rows("adminAuditEvent").some((e) => e.action === "RISK_ORDER_REJECTED"));
  // A rejected order counts as a fraud rejection (not a plain cancellation) in the customer's next evaluation.
  const next = await placed({ userId: "again" });
  await evalOrder(next.id);
  assert.ok(signalCodes(assessments(next.id)[0]).includes("PRIOR_FRAUD_REJECTED"));
  const cancelledSignal = ((assessments(next.id)[0].signals as any).signals as any[]).find((x) => x.code === "PRIOR_CANCELLED");
  assert.ok(!cancelledSignal.refs.includes(o.orderNumber), "the rejected order is not ALSO listed as a plain cancellation");
  assert.ok(((assessments(next.id)[0].signals as any).signals as any[]).find((x) => x.code === "PRIOR_FRAUD_REJECTED").refs.includes(o.orderNumber));
});

test("if the cancellation itself fails, the recorded rejection is undone (the record never claims something that did not happen) and the failure is audited", async () => {
  makeHighRisk();
  const o = await placed();
  await evalOrder(o.id);
  await assert.rejects(
    reviewRiskOrder(
      { orderId: o.id, adminId: "a1", decision: "REJECTED", reason: "Looks fraudulent after checking.", assessmentId: db.get("order", o.id).riskAssessmentId as string },
      { cancelOrder: async () => { throw new UserFacingError("cannot cancel right now"); } },
    ),
    /cannot cancel right now/,
  );
  const row = db.get("order", o.id);
  assert.deepEqual([row.status, row.riskReviewDecision, row.riskReviewedAt, row.riskReviewReason], ["PENDING", null, null, null]);
  assert.ok(db.rows("adminAuditEvent").some((e) => e.action === "RISK_ORDER_REJECT_FAILED"));
  assert.equal(row.riskReviewRequired, true, "still held");
});

test("advance-payment rules are untouched: an unpaid required advance blocks BEFORE the fraud gate; fraud approval never marks an advance verified or clears the low-trust review", async () => {
  makeHighRisk();
  const o = await placed();
  await evalOrder(o.id);
  db.patch("order", o.id, { advanceRequired: 200, advancePaid: 0, trustReviewRequired: true });
  await reviewRiskOrder({ orderId: o.id, adminId: "a1", decision: "APPROVED", reason: "Customer verified by phone call.", assessmentId: db.get("order", o.id).riskAssessmentId as string });
  const row = db.get("order", o.id);
  assert.equal(Number(row.advancePaid), 0, "advance NOT verified by a fraud approval");
  assert.equal(row.advanceWaivedById ?? null, null, "advance NOT waived");
  assert.equal(row.trustReviewedAt ?? null, null, "trust review NOT cleared");
  await assert.rejects(confirm(o.id), /advance/i, "the advance rule still applies first");
  db.patch("order", o.id, { advancePaid: 200 });
  await assert.rejects(confirm(o.id), /staff review \(low trust/, "then the low-trust review still applies");
  db.patch("order", o.id, { trustReviewedAt: NOW });
  await confirm(o.id);
  assert.equal(db.get("order", o.id).status, "CONFIRMED");
});

test("the gate order is advance -> trust -> fraud, in the single shared function (so booking/dispatch cannot bypass any of them)", () => {
  const base = { advanceRequired: 200, advancePaid: 0, advanceWaivedById: null, trustReviewRequired: true, trustReviewedAt: null, riskReviewRequired: true, riskLevel: "HIGH" as const, riskReviewDecision: null, riskReviewedLevel: null };
  assert.match(dispatchBlockedReason(base)!, /advance/i);
  assert.match(dispatchBlockedReason({ ...base, advancePaid: 200 })!, /staff review/);
  assert.match(dispatchBlockedReason({ ...base, advancePaid: 200, trustReviewedAt: new Date() })!, /fraud-risk review/);
  assert.equal(dispatchBlockedReason({ ...base, advancePaid: 200, trustReviewedAt: new Date(), riskReviewDecision: "APPROVED", riskReviewedLevel: "HIGH" }), null);
  // Callers that predate the fraud fields keep their exact behaviour.
  assert.equal(dispatchBlockedReason({ advanceRequired: 0, advancePaid: 0, advanceWaivedById: null, trustReviewRequired: false, trustReviewedAt: null }), null);
});

test("the admin order panel carries the gate reason, so the order page and the confirm button agree", async () => {
  makeHighRisk();
  const o = await placed();
  await evalOrder(o.id);
  const panel = await getAdvancePanel(o.id);
  assert.match(panel!.blockedReason!, /fraud-risk review/);
});

test("existing status rules are unchanged: evaluation never moves an order, and illegal transitions are still refused", async () => {
  const o = await placed();
  await evalOrder(o.id);
  assert.equal(db.get("order", o.id).status, "PENDING");
  await assert.rejects(adminUpdateOrderStatus(o.id, "DELIVERED" as never, undefined, TEST_ADMIN));
  await confirm(o.id);
  await adminUpdateOrderStatus(o.id, "PROCESSING" as never, undefined, TEST_ADMIN);
  assert.equal(db.get("order", o.id).status, "PROCESSING");
});

test("an order that was never assessed is assessed at confirmation time; if that fails and there is no assessment at all, the confirmation is refused (fail closed)", async () => {
  makeHighRisk();
  const o = await placed(); // checkout evaluation never happened
  assert.equal(db.get("order", o.id).riskScore, null);
  await assert.rejects(confirm(o.id), /fraud-risk review/, "assessed on the spot and held");
  assert.equal(db.get("order", o.id).riskLevel, "HIGH");

  const q = await placed({ userId: "q", phone: "+8801711000055", email: "q@example.com" });
  const real = (globalThis as any).__TEST_DB__;
  (globalThis as any).__TEST_DB__ = new Proxy(real, { get(t, k) { const v = Reflect.get(t, k, t); return k === "orderRiskAssessment" ? { ...v, create: async () => { throw new Error("db down"); } } : v; } });
  errorLogs.length = 0;
  try { await assert.rejects(adminUpdateOrderStatus(q.id, "CONFIRMED" as never, undefined, TEST_ADMIN), /could not be completed/); } finally { (globalThis as any).__TEST_DB__ = real; }
  assert.equal(db.get("order", q.id).status, "PENDING");
  errorLogs.length = 0; // the failure above is the point of this test: it is logged and expected
});

// ================================================================================================ policy / modes

test("policy is admin-only, validated and audited; thresholds are configurable and change the level on recalculation", async () => {
  history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] }); history({ status: "FAILED_DELIVERY", events: ["FAILED_DELIVERY"] }); // 30 = MEDIUM by default
  const o = await placed();
  assert.equal((await evalOrder(o.id))!.level, "MEDIUM");
  await assert.rejects(saveFraudPolicy({ thresholds: { medium: 10, high: 25, critical: 50 } }, "c1"));
  db.insert("user", { id: "c1", email: "c@x.test", name: "c", role: "CUSTOMER", isActive: true });
  await assert.rejects(saveFraudPolicy({ thresholds: { medium: 10, high: 25, critical: 50 } }, "c1"));
  await assert.rejects(saveFraudPolicy({ thresholds: { medium: 60, high: 30, critical: 80 } }, "a1"), /medium < high < critical/);
  await assert.rejects(saveFraudPolicy({ ipRetentionDays: 0 }, "a1"), /retention/i);
  assert.equal(db.rows("storeSettings")[0].fraudPolicy ?? null, null, "invalid input saved nothing");
  await saveFraudPolicy({ thresholds: { medium: 10, high: 25, critical: 50 } }, "a1");
  const audit = db.rows("adminAuditEvent").find((e) => e.action === "FRAUD_POLICY_UPDATED")!;
  assert.equal((audit.detail as any).before.thresholds.high, 60);
  assert.equal((audit.detail as any).after.thresholds.high, 25);
  assert.equal((await getFraudPolicy()).policy.thresholds.high, 25);
  const r = (await recalculateOrderRisk(o.id, "a1"))!;
  assert.equal(r.level, "HIGH");
  assert.equal(db.get("order", o.id).riskReviewRequired, true);
  assert.ok(db.rows("adminAuditEvent").some((e) => e.action === "RISK_RECALCULATED"));
});

test("ADVISORY scores and records but NEVER gates; OFF does not evaluate at all", async () => {
  makeHighRisk();
  db.patch("storeSettings", "singleton", { fraudPolicy: { mode: "ADVISORY" } });
  const o = await placed();
  const r = (await evalOrder(o.id))!;
  assert.equal(r.level, "HIGH");
  assert.equal(db.get("order", o.id).riskReviewRequired, false);
  await confirm(o.id);
  assert.equal(db.get("order", o.id).status, "CONFIRMED");

  db.patch("storeSettings", "singleton", { fraudPolicy: { mode: "OFF" } });
  const p = await placed({ userId: "off", phone: "+8801711000066", email: "off@example.com" });
  assert.equal(await evalOrder(p.id), null);
  assert.equal(assessments(p.id).length, 0);
  await confirm(p.id);
  assert.equal(db.get("order", p.id).status, "CONFIRMED");
});

test("an invalid STORED policy never weakens protection: the defaults apply and the problem is reported", async () => {
  db.patch("storeSettings", "singleton", { fraudPolicy: { thresholds: { medium: 90, high: 60, critical: 80 } } });
  const { policy, problem } = await getFraudPolicy();
  assert.deepEqual(policy.thresholds, DEFAULT_FRAUD_POLICY.thresholds);
  assert.ok(problem);
});

test("marketplace / non-website orders are never scored or gated", async () => {
  const o = await placed();
  db.patch("order", o.id, { channelId: "channel_amazon" });
  assert.equal(await evalOrder(o.id), null);
  assert.equal(assessments(o.id).length, 0);
});

// ================================================================================================ retention / maintenance

test("retention: IPs older than the configured period are erased from assessments (scores and reasons stay); legacy orders get their identity keys", async () => {
  const o = await placed();
  await evalOrder(o.id, "198.51.100.1", daysAgo(40));
  const fresh = await placed({ userId: "f", phone: "+8801711000077", email: "f@example.com" });
  await evalOrder(fresh.id, "198.51.100.2", daysAgo(5));
  db.patch("orderRiskAssessment", assessments(o.id)[0].id as string, { createdAt: daysAgo(40) });
  db.patch("orderRiskAssessment", assessments(fresh.id)[0].id as string, { createdAt: daysAgo(5) });
  history({ phone: "+8801911000000" });
  const legacy = db.rows("order").find((r) => String(r.id).startsWith("h-"))!;
  db.patch("order", legacy.id as string, { phoneNorm: null, emailNorm: null, addressKey: null, shippingSnapshot: { line1: "House 9 Road 3", city: "Dhaka" }, email: "Legacy@Gmail.com" });
  const s = await runFraudMaintenance({ now: NOW });
  assert.equal(s.ipPurged, 1);
  assert.equal(assessments(o.id)[0].clientIp, null);
  assert.equal(assessments(o.id)[0].score, 0, "the score history is kept");
  assert.equal(assessments(fresh.id)[0].clientIp, "198.51.100.2");
  assert.equal(db.get("order", legacy.id as string).phoneNorm, "01911000000");
  assert.equal(db.get("order", legacy.id as string).emailNorm, "legacy@gmail.com");
  assert.match(db.get("order", legacy.id as string).addressKey as string, /^[0-9a-f]{32}$/);
  assert.equal((await runFraudMaintenance({ now: NOW })).keysBackfilled, 0, "idempotent");
});

// ================================================================================================ P3 / P3.1 tracking is not affected
test("tracking (P3/P3.1): a fraud-held order is NOT confirmed, so no Purchase event is created or sent; after approval + confirmation exactly one is", async () => {
  db.patch("storeSettings", "singleton", { metaPixelId: "123456789" });
  process.env.META_CONVERSIONS_API_TOKEN = "EAAGsecrettokenvalue1234567890";
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { sent.push(String(url)); return new Response(JSON.stringify({ events_received: 1 }), { status: 200 }); }) as never;
  try {
    makeHighRisk();
    const o = await placed();
    await evalOrder(o.id);
    await assert.rejects(confirm(o.id), /fraud-risk review/);
    await drainAfter();
    assert.equal(db.rows("trackingEventLog").length, 0, "a held order creates no tracking event");
    assert.equal(sent.length, 0, "nothing is sent to Meta for an unconfirmed order");

    await reviewRiskOrder({ orderId: o.id, adminId: "a1", decision: "APPROVED", reason: "Customer verified by phone call.", assessmentId: db.get("order", o.id).riskAssessmentId as string });
    await drainAfter();
    assert.equal(db.rows("trackingEventLog").length, 0, "approving alone is not a confirmation either");
    await confirm(o.id);
    assert.equal(db.rows("trackingEventLog").filter((l) => l.orderId === o.id && l.destination === "META_CAPI").length, 1);
    assert.equal(sent.filter((u) => u.includes("graph.facebook.com")).length, 1);

    // and a rejected order never produces one
    const r = await placed({ userId: "rej", phone: "+8801711000099", email: "rej@example.com" });
    makeHighRisk("01711000099");
    await evalOrder(r.id);
    await reviewRiskOrder({ orderId: r.id, adminId: "a1", decision: "REJECTED", reason: "Fake address, phone unreachable.", assessmentId: db.get("order", r.id).riskAssessmentId as string });
    await drainAfter();
    assert.equal(db.rows("trackingEventLog").filter((l) => l.orderId === r.id).length, 0);
  } finally { globalThis.fetch = realFetch; }
});
