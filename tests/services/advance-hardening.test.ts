import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dhakaDay, emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog, TEST_ADMIN } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { prisma } from "@/lib/db/prisma";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, getOrderByNumberForCurrentUser, placeOrder } from "@/server/services/order.service";
import {
  assertAdminActor, getAdvancePanel, getAdvanceSettings, quoteAdvance, rejectAdvancePayment, reviewTrustOrder, saveAdvanceSettings, syncOrderPayment,
  verifyAdvancePayment, waiveAdvance,
} from "@/server/services/advance.service";
import { resetFraudCheckStateForTests, setFraudCheckProviderForTests, setPhoneVerifiedForTests } from "@/server/services/fraud-check.service";
import { bookOrderWithCourier } from "@/server/services/courier.service";
import { recordIncident } from "@/server/services/incident.service";
import { getAccounting } from "@/server/services/accounting.service";
import { createExternalOrder } from "@/server/services/external-order.service";
import { getAccountOverview } from "@/server/services/account.service";
import { rejectAdvanceAction, reviewTrustAction, saveAdvanceSettingsAction, verifyAdvanceAction, waiveAdvanceAction } from "@/server/actions/admin-advance.actions";
import { updatePaymentStatusAction } from "@/server/actions/admin-order.actions";
import { getCourierConfig } from "@/lib/courier/config";
import { createSteadfastProvider } from "@/lib/courier/steadfast";
import type { CourierProvider } from "@/lib/courier/types";

let db: FakeDb;
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
// Provider DOUBLE for tests only: serves the records a test registers via history(). It is not a real fraud-check integration.
const records = new Map<string, { delivered: number; cancelled: number; returned?: number }>();
let providerThrows = false;
let providerMode: "ok" | "slow" | "garbage" = "ok";
const phoneOf = (user: string) => { let h = 0; for (const c of user) h = (h * 31 + c.charCodeAt(0)) % 10_000_000; return `0171${String(h).padStart(7, "0")}`; };
beforeEach(() => {
  records.clear(); providerThrows = false; providerMode = "ok";
  process.env.FRAUD_CHECK_CACHE_SECONDS = "0"; resetFraudCheckStateForTests();   // these tests change the stand-in answer for the same phone: caching has its own tests (tests/unit/fraud-check-service.test.ts)
  setPhoneVerifiedForTests(true);   // simulates a future verified-phone mechanism; tests that cover the real (unverified) default reset it to undefined
  setFraudCheckProviderForTests({ key: "test-double", check: async (phone) => { if (providerThrows) throw new Error("provider down"); if (providerMode === "slow") return new Promise(() => {}); if (providerMode === "garbage") return { delivered: "9", cancelled: -1 } as never; return records.get(phone) ?? { delivered: 0, cancelled: 0 }; } });
  db = freshDb(); seedCatalog(db); seedAdmins(db);
  db.insert("salesChannel", { id: "channel_website", key: "website", name: "Website", kind: "WEBSITE" });
  db.insert("salesChannel", { id: "channel_fb", key: "facebook", name: "Facebook Shop", kind: "OTHER" });
  db.insert("user", { id: "cust-1", email: "c1@x.test", name: "Cust", role: "CUSTOMER", isActive: true });
  db.insert("product", { id: "p-cheap", name: "Cheap", slug: "cheap", type: "STANDARD", status: "ACTIVE", price: 20, costPrice: 5, stock: 500, description: "x" });
  db.patch("product", "p-standard", { stock: 100 });
});
const policy = { enabled: true, zones: ["OUTSIDE_DHAKA"] as never, standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true, instructions: "Send to bKash 01XXXXXXXXX" };
const on = (o: Record<string, unknown> = {}) => saveAdvanceSettings({ ...policy, ...o } as never, "a1");
const claim = (ref = "TX12345678") => ({ advanceMethod: "BKASH", advanceReference: ref });
const order = (user: string | null, extra: Record<string, unknown> = {}, productId = "p-standard", qty = 1) =>
  runAs(user ? { sub: user } : null, async () => { await addItemToCart({ productId, quantity: qty }); return placeOrder({ ...emptyCheckout, deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Sylhet", ...(user ? { phone: phoneOf(user) } : {}) }, ...extra } as never); });
const row = (id: string) => db.get("order", id);
const pays = (orderId: string) => db.rows("payment").filter((p) => p.orderId === orderId);
const audit = (action?: string) => db.rows("adminAuditEvent").filter((e) => !action || e.action === action);
const move = (id: string, to: string) => admin(() => adminUpdateOrderStatus(id, to as never, undefined, TEST_ADMIN));
/** Registers a provider-stand-in record for the user's phone. extra: CANCELLED / FAILED_DELIVERY add cancelled parcels. The account phone is irrelevant: no phone is verified. */
const history = (user: string, delivered: number, extra: Record<string, number> = {}) => {
  const phone = phoneOf(user);
  const cur = records.get(phone) ?? { delivered: 0, cancelled: 0 };
  records.set(phone, { delivered: cur.delivered + delivered, cancelled: cur.cancelled + Object.values(extra).reduce((a, n) => a + n, 0) });
};

// ---- policy: server decides, scope, defaults, amounts, totals ------------------------------------------------------------------------
test("the server decides: a new customer outside Dhaka owes the standard 200; the stored amount is the server's, and the claim stays an unverified claim", async () => {
  await on();
  const o = await order(null, claim(" tx-1234 5678 "));
  const r = row(o.id);
  assert.deepEqual([Number(r.advanceRequired), Number(r.advancePaid), r.paymentStatus, r.trustScore], [200, 0, "UNPAID", 50]);
  const [p] = pays(o.id);
  assert.deepEqual([p.status, p.kind, p.providerRef, Number(p.amount)], ["PENDING", "ADVANCE", null, 200]);   // reference is only the customer's claim; nothing verified
  assert.equal(p.customerReference, " tx-1234 5678 ".trim());
  assert.equal((await getAdvancePanel(o.id))!.remaining, Number(r.total));                                   // nothing received: the whole total is still owed
});

test("a claim without a reference is refused when an advance is required; scope off or an uncovered zone needs none", async () => {
  await on();
  await assert.rejects(order(null, {}), /advance of 200 is required/);
  await assert.rejects(order(null, { advanceMethod: "BKASH", advanceReference: "ab" }), /advance of 200 is required/);
  assert.equal(db.rows("order").length, 0);
  const dhaka = await order(null, { deliveryZone: "DHAKA_CITY", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Dhaka" } });
  assert.equal(Number(row(dhaka.id).advanceRequired), 0);
  await on({ enabled: false });
  const off = await order(null, {});
  assert.equal(Number(row(off.id).advanceRequired), 0);
  assert.equal(pays(off.id).length, 0);
});

test("zone scope is configurable: with Dhaka City in scope a Dhaka order needs the advance", async () => {
  await on({ zones: ["DHAKA_CITY"] });
  const o = await order(null, { deliveryZone: "DHAKA_CITY", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Dhaka" }, ...claim() });
  assert.equal(Number(row(o.id).advanceRequired), 200);
  const outside = await order(null, {});
  assert.equal(Number(row(outside.id).advanceRequired), 0);
});

test("a 'Dhaka City' claim for a non-Dhaka address cannot dodge the advance: the stricter zone applies and the order is flagged for review", async () => {
  await on();                                                             // advance applies outside Dhaka only
  const liar = await order(null, { deliveryZone: "DHAKA_CITY", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Chattogram", line1: "Agrabad" }, ...claim("TXLIAR0001") });
  const r = row(liar.id);
  assert.equal(Number(r.advanceRequired), 200);
  assert.equal(r.trustReviewRequired, true);
  assert.deepEqual((r.trustSnapshot as any).zone, { claimed: "DHAKA_CITY", applied: "OUTSIDE_DHAKA", conflict: true });
  assert.equal(r.deliveryZone, "DHAKA_CITY");                              // what the customer chose stays recorded, as evidence
});

test("amounts: advance is capped at the order total and the remaining COD balance is total - advance; delivery charges are part of the total", async () => {
  await on({ standardAmount: 5000, reducedAmount: 2500 });
  const small = await order(null, claim("TXSMALL001"), "p-cheap", 1);
  const s = row(small.id);
  assert.ok(Number(s.total) < 5000);
  assert.equal(Number(s.advanceRequired), Number(s.total));                // capped at the order amount (item + delivery)
  assert.equal(pays(small.id)[0].amount, Number(s.total));
  await on({ standardAmount: 200 });
  const big = await order(null, claim("TXBIG00001"), "p-standard", 2);
  const b = row(big.id);
  assert.equal(Number(b.advanceRequired), 200);
  const panel = (await getAdvancePanel(big.id))!;
  assert.equal(panel.total, Number(b.total));
  await verifyViaService(big.id, "WALLETBIG1", 200);
  assert.equal((await getAdvancePanel(big.id))!.remaining, Number(b.total) - 200);
});

test("checkout total changes are re-priced at placement: more items change the total, the advance is recomputed from the NEW total, never from an earlier quote", async () => {
  await on({ standardAmount: 1000, reducedAmount: 500 });
  const one = await order(null, claim("TXONE00001"), "p-cheap", 1);       // total ~ 20 + delivery  -> capped
  const many = await order(null, claim("TXMANY0001"), "p-cheap", 50);     // total ~ 1000 + delivery -> full 1000
  assert.ok(Number(row(one.id).advanceRequired) < 1000);
  assert.equal(Number(row(many.id).advanceRequired), 1000);
  const quote = await quoteAdvance(prisma, { zone: "OUTSIDE_DHAKA", orderTotal: 300 });
  assert.equal(quote.decision.required, 300);                              // same customer, smaller total, smaller advance: the amount follows the total
});

// ---- policy changes ------------------------------------------------------------------------------------------------------------------------
test("changing the policy affects NEW orders only; each existing order keeps the decision, score, reasons and policy it was created with", async () => {
  await on();
  const before = await order("cust-1", claim("TXBEFORE01"));
  const snap = JSON.stringify(row(before.id).trustSnapshot);
  await on({ standardAmount: 350, reducedAmount: 150, lowBelow: 20, reducedFrom: 60 });
  const after = await order("cust-1", claim("TXAFTER001"));
  assert.equal(Number(row(after.id).advanceRequired), 350);
  assert.equal(Number(row(before.id).advanceRequired), 200);               // unchanged
  assert.equal(JSON.stringify(row(before.id).trustSnapshot), snap);
  assert.equal((row(before.id).trustSnapshot as any).policy.standard, 200);
  assert.equal((row(after.id).trustSnapshot as any).policy.standard, 350);
  assert.equal(row(before.id).trustReviewRequired, true);                   // the old order's review requirement was decided by the old policy
  assert.equal(row(after.id).trustReviewRequired, false);                   // score 50 is now >= 20
});

test("policy changes are validated, stored, attributed and audited with before/after values; invalid saves change nothing", async () => {
  await on();
  assert.equal(audit("ADVANCE_POLICY_CHANGED").length, 1);
  await on({ standardAmount: 250 });
  const [first, second] = audit("ADVANCE_POLICY_CHANGED");
  assert.equal((first.detail as any).after.standard, 200);
  assert.deepEqual([(second.detail as any).before.standard, (second.detail as any).after.standard, second.actorId], [200, 250, "a1"]);
  const stored = db.get("storeSettings", "singleton");
  assert.deepEqual([Number(stored.advanceStandardAmount), stored.advancePolicyUpdatedById], [250, "a1"]);
  for (const bad of [{ reducedAmount: 900 }, { lowBelow: 95 }, { zones: [] }, { standardAmount: -5 }, { standardAmount: 10.123 }, { fullAt: 101 }]) {
    await assert.rejects(on(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(Number(db.get("storeSettings", "singleton").advanceStandardAmount), 250);
  assert.equal(audit("ADVANCE_POLICY_CHANGED").length, 2);
});

test("stored settings that are invalid (hand-edited database) fall back to the safe defaults and say so", async () => {
  await on();
  db.patch("storeSettings", "singleton", { advanceStandardAmount: 5, advanceReducedAmount: 900, trustLowBelow: 95 });
  const s = await getAdvanceSettings();
  assert.ok(s.problem);
  assert.deepEqual([s.standardAmount, s.reducedAmount, s.lowBelow, s.reducedFrom, s.fullAt, s.zeroAtFullTrust], [200, 100, 60, 80, 100, false]);
  const o = await order(null, claim("TXFALLBACK"));
  assert.equal(Number(row(o.id).advanceRequired), 200);
  assert.ok((row(o.id).trustSnapshot as any).settingsProblem);
});

test("only an authorised admin can change the policy: the action refuses customers and guests, and the service refuses non-admin actors", async () => {
  await assert.rejects(runAs({ sub: "cust-1" }, () => saveAdvanceSettingsAction({ ...policy } as never)));
  await assert.rejects(runAs(null, () => saveAdvanceSettingsAction({ ...policy } as never)));
  await assert.rejects(saveAdvanceSettings(policy as never, "cust-1"), /not authorised/);
  await assert.rejects(saveAdvanceSettings(policy as never, null), /not authorised/);
  await assert.rejects(saveAdvanceSettings(policy as never, "ghost"), /not authorised/);
  assert.equal(audit().length, 0);                                                      // nothing was saved, nothing was audited
  assert.equal((await admin(() => saveAdvanceSettingsAction({ ...policy } as never))).success, true);
});

// ---- trust scoring: boundaries through the real flow, stored decision, history changes ----------------------------------------------------
test("scores reachable through real history map to the documented tiers: 50 new, 60, 80 and 100 (zero advance only when enabled)", async () => {
  await on();
  const amountFor = async (user: string) => { const o = await order(user, claim(`TX${user.toUpperCase()}00001`)); return [row(o.id).trustScore, Number(row(o.id).advanceRequired), row(o.id).trustReviewRequired]; };
  assert.deepEqual(await amountFor("u0"), [50, 200, true]);                   // new customer: conservative default, standard advance, review
  history("u1", 1); assert.deepEqual(await amountFor("u1"), [60, 200, false]);   // 60 = standard tier boundary
  history("u3", 3); assert.deepEqual(await amountFor("u3"), [80, 100, false]);   // 80 = reduced tier boundary
  history("u5", 5); assert.deepEqual(await amountFor("u5"), [100, 100, false]);  // 100, but zero-advance rule is OFF
  await on({ zeroAtFullTrust: true });
  history("u6", 5); assert.deepEqual(await amountFor("u6"), [100, 0, false]);    // rule explicitly enabled: zero advance at 100 only
  assert.deepEqual(await amountFor("u3"), [80, 100, false]);                      // 80 is NOT full trust: still pays the reduced advance
});

test("the order stores the applied score, the reasons, the policy snapshot, the zone and the decision — and later history never rewrites them", async () => {
  await on();
  history("u9", 3);
  const o = await order("u9", claim("TXSNAP0001"));
  const snap = row(o.id).trustSnapshot as any;
  assert.deepEqual([row(o.id).trustScore, snap.score, snap.tier, snap.needsReview], [80, 80, "reduced", false]);
  assert.ok(snap.reasons.length > 0 && snap.explanation.includes("80/100"));
  assert.deepEqual([snap.policy.standard, snap.policy.reduced, snap.policy.lowBelow, snap.policy.reducedFrom, snap.policy.fullAt, snap.policy.zeroAtFullTrust], [200, 100, 60, 80, 100, false]);
  assert.match(snap.scoreMeaning, /not a probability/i);
  const stored = JSON.stringify([row(o.id).trustScore, row(o.id).trustSnapshot, row(o.id).advanceRequired, row(o.id).trustReviewRequired]);
  // the customer's history turns bad afterwards: the old order's decision does not move
  history("u9", 0, { FAILED_DELIVERY: 3, CANCELLED: 2 });
  await verifyViaService(o.id, "WALLETSNAP1", 100);
  await move(o.id, "CONFIRMED");
  assert.equal(JSON.stringify([row(o.id).trustScore, row(o.id).trustSnapshot, row(o.id).advanceRequired, row(o.id).trustReviewRequired]), stored);
  assert.equal((await getAdvancePanel(o.id))!.trustScore, 80);
});

test("fraud-check rules (verified phone path, simulated): record counts; unavailable, no-history and invalid answers all fail safe to 50 without blocking checkout", async () => {
  await on();
  const q = (phone: string | null) => quoteAdvance(prisma, { phone, zone: "OUTSIDE_DHAKA", orderTotal: 1000 });
  const why = (o: any) => ({ status: o.status, reason: o.reason });   // outcomes also carry checkedAt/cached since Phase 7.4
  history("uw", 5);
  assert.equal((await q(phoneOf("uw"))).trust.score, 100);
  history("ubad", 5, { CANCELLED: 3 });
  assert.equal((await q(phoneOf("ubad"))).trust.score, 40);                       // 50 + 50 - 3*20
  const none = await q("01711999999");
  assert.deepEqual([none.fraud.outcome.status, none.trust.score], ["no_history", 50]);
  for (const bad of [null, "", "not-a-phone", "12345"]) { const r = await q(bad); assert.deepEqual([r.fraud.outcome.status, r.trust.score, r.decision.required], ["unavailable", 50, 200]); }
  providerThrows = true;
  const err = await q(phoneOf("uw")); assert.deepEqual([why(err.fraud.outcome), err.trust.score], [{ status: "unavailable", reason: "error" }, 50]);
  providerThrows = false; providerMode = "garbage";
  const junk = await q(phoneOf("uw")); assert.deepEqual([why(junk.fraud.outcome), junk.trust.score], [{ status: "unavailable", reason: "invalid_response" }, 50]);
  setFraudCheckProviderForTests(null);
  const off = await q(phoneOf("uw")); assert.deepEqual([why(off.fraud.outcome), off.trust.score, off.decision.required], [{ status: "unavailable", reason: "no_provider" }, 50, 200]);
});

test("REAL default today (no verified-phone mechanism): delivered history earns nothing, cancelled history still lowers trust, standard advance for everyone", async () => {
  await on();
  setPhoneVerifiedForTests(undefined);
  history("ug", 5);
  history("ub", 0, { CANCELLED: 2 });
  const q = (u: string) => quoteAdvance(prisma, { phone: phoneOf(u), zone: "OUTSIDE_DHAKA", orderTotal: 1000 });
  const good = await q("ug");
  assert.deepEqual([good.trust.score, good.decision.required, good.fraud.phoneVerified, good.decision.needsReview], [50, 200, false, true]);
  const bad = await q("ub");
  assert.deepEqual([bad.trust.score, bad.decision.required], [10, 200]);
});

test("a provider that never answers times out after the limit and checkout proceeds with the default", async () => {
  await on();
  providerMode = "slow";
  const t0 = Date.now();
  const o = await order(null, claim("TXSLOW0001"));
  assert.ok(Date.now() - t0 < 6000);
  assert.deepEqual([row(o.id).trustScore, Number(row(o.id).advanceRequired)], [50, 200]);
  const fcTimeout = (row(o.id).trustSnapshot as any).fraudCheck;
  const { checkedAt: t1, ...rest1 } = fcTimeout;
  assert.deepEqual(rest1, { status: "unavailable", reason: "timeout", provider: null, delivered: null, cancelled: null, returned: null, total: null, source: "fallback", cached: false, phoneVerified: true, phoneLast4: emptyCheckout.shippingAddress.phone.replace(/\D/g, "").slice(-4) });
  assert.ok(!Number.isNaN(Date.parse(t1)));
});

test("the order snapshot records the fraud-check evidence without the phone number, and customers cannot see it", async () => {
  await on();
  history("usn", 2, { CANCELLED: 1 });
  const o = await order("usn", claim("TXFRAUDSN1"));
  const fc = (row(o.id).trustSnapshot as any).fraudCheck;
  const { checkedAt: t2, ...rest2 } = fc;
  assert.deepEqual(rest2, { status: "ok", reason: null, provider: "test-double", delivered: 2, cancelled: 1, returned: null, total: 3, source: "provider", cached: false, phoneVerified: true, phoneLast4: phoneOf("usn").slice(-4) });
  assert.ok(!Number.isNaN(Date.parse(t2)));
  assert.equal(JSON.stringify(row(o.id).trustSnapshot).includes(phoneOf("usn")), false);
  const panel = await getAdvancePanel(o.id);
  assert.equal(panel!.trust!.fraudCheck!.status, "ok");
  const mine = await runAs({ sub: "usn" }, () => getOrderByNumberForCurrentUser(row(o.id).orderNumber as string));
  assert.ok(mine);
  assert.equal(JSON.stringify(mine).match(/fraudCheck|trustSnapshot|trustScore|test-double/) , null);
});

test("a customer cannot influence their own score, amount, waiver or review requirement through the checkout input", async () => {
  await on();
  // extra hostile fields in the checkout input are ignored by placeOrder
  const o = await order("u-hostile", { ...claim("TXHOSTILE1"), trustScore: 100, advanceRequired: 0, advancePaid: 500, trustReviewRequired: false, advanceWaivedById: "a1", paymentStatus: "PAID" });
  const r = row(o.id);
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), Number(r.advancePaid), r.paymentStatus, r.advanceWaivedById, r.trustReviewRequired], [50, 200, 0, "UNPAID", null, true]);
});

// ---- unverified claims, duplicate references ---------------------------------------------------------------------------------------------------
test("an unverified claim is not money: balance, status, accounting and the gate ignore it until staff verify", async () => {
  await on();
  const o = await order(null, claim("TXCLAIM001"));
  const derived = await prisma.$transaction((tx) => syncOrderPayment(tx, o.id));
  assert.deepEqual([derived.paid, derived.status], [0, "UNPAID"]);
  await assert.rejects(move(o.id, "CONFIRMED"), /advance/);
  assert.equal(Number(row(o.id).advancePaid), 0);
  await verifyViaService(o.id, "WALLETOK01", 200);
  assert.deepEqual([Number(row(o.id).advancePaid), row(o.id).paymentStatus, pays(o.id)[0].status, pays(o.id)[0].verifiedById], [200, "PARTIALLY_PAID", "PAID", "a1"]);
  assert.equal(pays(o.id)[0].providerRef, "WALLETOK01");                           // the wallet statement's id as confirmed by staff, not the customer's text
});

test("one transaction can never be verified or credited to two orders: any spelling, either order, retries, and the admin sees the clash", async () => {
  await on();
  const a = await order(null, claim("TX-SAME 0001"));
  const b = await order(null, { ...claim("tx-same-0001"), email: "other@example.com" }, "p-standard", 1);
  const panelA = (await getAdvancePanel(a.id))!;
  assert.deepEqual(panelA.payments[0].sameReferenceOn, [row(b.id).orderNumber]);   // the claim is visible as shared
  const [payA, payB] = [pays(a.id)[0].id as string, pays(b.id)[0].id as string];
  await admin(() => verifyAdvancePayment({ paymentId: payA, adminId: "a1", providerRef: "TXSAME0001", amount: 200 }));
  for (const spelling of ["TXSAME0001", "txsame0001", " tx-same 0001 "]) {
    await assert.rejects(admin(() => verifyAdvancePayment({ paymentId: payB, adminId: "a1", providerRef: spelling, amount: 200 })), /already been used/);
  }
  await assert.rejects(admin(() => verifyAdvancePayment({ paymentId: payA, adminId: "a1", providerRef: "TXSAME0001", amount: 200 })), /already verified/);   // retry of the same verification
  assert.deepEqual([Number(row(a.id).advancePaid), Number(row(b.id).advancePaid), pays(b.id)[0].status], [200, 0, "PENDING"]);
  await assert.rejects(move(b.id, "CONFIRMED"), /advance/);                          // B stays blocked: its claim is still unverified
  assert.equal(audit("ADVANCE_VERIFIED").length, 1);
});

test("verification amounts are the admin's, validated: positive, never above the order total, never double-counted", async () => {
  await on();
  const o = await order(null, claim("TXAMOUNT01"));
  const id = pays(o.id)[0].id as string;
  for (const amount of [0, -5, Number.NaN]) await assert.rejects(admin(() => verifyAdvancePayment({ paymentId: id, adminId: "a1", providerRef: "WALLETAMT1", amount })));
  await assert.rejects(admin(() => verifyAdvancePayment({ paymentId: id, adminId: "a1", providerRef: "WALLETAMT1", amount: Number(row(o.id).total) + 1 })), /more than this order's total/);
  assert.deepEqual([pays(o.id)[0].status, Number(row(o.id).advancePaid)], ["PENDING", 0]);     // a refused verification changes nothing
});

// ---- authorisation and audit -------------------------------------------------------------------------------------------------------------------
test("unauthorised verification, rejection, waiver and review are refused at the action AND at the service; nothing changes and nothing is audited", async () => {
  await on();
  const o = await order(null, claim("TXAUTH0001"));
  const payId = pays(o.id)[0].id as string;
  for (const who of [{ sub: "cust-1" }, null]) {
    await assert.rejects(runAs(who as never, () => verifyAdvanceAction({ orderId: o.id, paymentId: payId, providerRef: "WALLETAUTH", amount: 200 })));
    await assert.rejects(runAs(who as never, () => rejectAdvanceAction({ orderId: o.id, paymentId: payId, reason: "nope" })));
    await assert.rejects(runAs(who as never, () => waiveAdvanceAction({ orderId: o.id, reason: "just let it through" })));
    await assert.rejects(runAs(who as never, () => reviewTrustAction({ orderId: o.id, note: "looks fine" })));
  }
  for (const actor of ["cust-1", "ghost", "", null as never]) {
    await assert.rejects(verifyAdvancePayment({ paymentId: payId, adminId: actor, providerRef: "WALLETAUTH", amount: 200 }), /not authorised/);
    await assert.rejects(rejectAdvancePayment({ paymentId: payId, adminId: actor, reason: "nope" }), /not authorised/);
    await assert.rejects(waiveAdvance({ orderId: o.id, adminId: actor, reason: "just let it through" }), /not authorised/);
    await assert.rejects(reviewTrustOrder({ orderId: o.id, adminId: actor, note: "looks fine" }), /not authorised/);
  }
  db.patch("user", "a2", { isActive: false });                                         // a deactivated admin is not authorised either
  await assert.rejects(assertAdminActor(prisma, "a2"), /not authorised/);
  assert.deepEqual([pays(o.id)[0].status, Number(row(o.id).advancePaid), row(o.id).advanceWaivedById, row(o.id).trustReviewedAt], ["PENDING", 0, null, null]);
  assert.equal(audit().filter((e) => e.action !== "ADVANCE_POLICY_CHANGED").length, 0);
});

test("a waiver needs a reason and an admin, records who/when/why in the order AND the audit trail, adds no money, and can happen once", async () => {
  await on();
  const o = await order(null, claim("TXWAIVE001"));
  for (const bad of ["", "   ", "ok", "no"]) await assert.rejects(waiveAdvance({ orderId: o.id, adminId: "a1", reason: bad }), /reason/);
  assert.equal(row(o.id).advanceWaivedById, null);
  await waiveAdvance({ orderId: o.id, adminId: "a1", reason: "  Known repeat customer, phoned  " });
  const r = row(o.id);
  assert.deepEqual([r.advanceWaivedById, r.advanceWaivedReason], ["a1", "Known repeat customer, phoned"]);
  assert.ok(r.advanceWaivedAt instanceof Date);
  const [ev] = audit("ADVANCE_WAIVED");
  assert.deepEqual([ev.actorId, ev.entityType, ev.entityId, (ev.detail as any).reason, (ev.detail as any).advanceRequired, (ev.detail as any).advancePaid], ["a1", "ORDER", o.id, "Known repeat customer, phoned", 200, 0]);
  assert.deepEqual([Number(r.advancePaid), r.paymentStatus], [0, "UNPAID"]);        // a waiver is a decision, not money
  const panel = (await getAdvancePanel(o.id))!;
  assert.deepEqual([panel.waived?.reason, panel.audit.map((e) => e.action)], ["Known repeat customer, phoned", ["ADVANCE_WAIVED"]]);
  await assert.rejects(waiveAdvance({ orderId: o.id, adminId: "a2", reason: "second waiver attempt" }), /only be waived once/);
  assert.equal(audit("ADVANCE_WAIVED").length, 1);
  // not possible when nothing is outstanding, or once the order has moved on
  const paid = await order(null, claim("TXWAIVE002"), "p-standard", 1);
  await verifyViaService(paid.id, "WALLETWV02", 200);
  await assert.rejects(waiveAdvance({ orderId: paid.id, adminId: "a1", reason: "nothing to waive here" }), /no outstanding advance/);
});

test("verification and rejection write who/when/what to the audit trail; a rejected claim is never money", async () => {
  await on();
  const a = await order(null, claim("TXAUDIT001"));
  await verifyViaService(a.id, "WALLETAUD1", 200);
  const [ev] = audit("ADVANCE_VERIFIED");
  assert.deepEqual([ev.actorId, ev.entityId, (ev.detail as any).providerRef, (ev.detail as any).claimedReference, (ev.detail as any).amount], ["a1", a.id, "WALLETAUD1", "TXAUDIT001", 200]);
  const b = await order(null, { ...claim("TXAUDIT002"), email: "b@example.com" });
  await assert.rejects(rejectAdvancePayment({ paymentId: pays(b.id)[0].id as string, adminId: "a1", reason: "" }), /reason/);
  await rejectAdvancePayment({ paymentId: pays(b.id)[0].id as string, adminId: "a1", reason: "No such transaction in the wallet statement" });
  assert.deepEqual([pays(b.id)[0].status, Number(row(b.id).advancePaid)], ["FAILED", 0]);
  assert.equal((audit("ADVANCE_REJECTED")[0].detail as any).reason, "No such transaction in the wallet statement");
  await assert.rejects(verifyAdvancePayment({ paymentId: pays(b.id)[0].id as string, adminId: "a1", providerRef: "WALLETAUD2", amount: 200 }), /already verified or rejected/);
});

// ---- dispatch enforcement ------------------------------------------------------------------------------------------------------------------------
const config = getCourierConfig({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: "KEY", COURIER_API_SECRET: "SEC", COURIER_WEBHOOK_SECRET: "wh-secret-0123456789" });
const fakeProvider = (): CourierProvider & { bookCalls: number } => {
  const real = createSteadfastProvider(config, (async () => ({ kind: "network", message: "unused" })) as never);
  const p = { ...real, key: "steadfast" as const, displayName: "Steadfast", bookCalls: 0, async book() { p.bookCalls++; return { ok: true as const, consignmentId: "C-1", trackingCode: "T-1", trackingUrl: null, providerStatus: "in_review" }; }, async fetchStatus() { return { ok: true as const, status: "delivered" }; } };
  return p as never;
};

test("an order that requires an advance cannot be confirmed, processed, shipped, delivered or booked with a courier until the advance is verified (or waived with a reason)", async () => {
  await on();
  history("u3", 3);                                                              // 80: no review requirement, so ONLY the advance gate is under test
  const o = await order("u3", claim("TXGATE0001"));
  await assert.rejects(move(o.id, "CONFIRMED"), /advance/);
  for (const to of ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) await assert.rejects(move(o.id, to), undefined, to);   // not even a legal transition from PENDING
  assert.equal(row(o.id).status, "PENDING");
  // inconsistent data: the status is already CONFIRMED but the advance never arrived (e.g. a manual database edit): dispatch is STILL refused
  db.patch("order", o.id, { status: "CONFIRMED" });
  await assert.rejects(move(o.id, "PROCESSING"), /advance/);
  const p = fakeProvider();
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config }), /advance/);
  assert.equal(p.bookCalls, 0);                                                    // no parcel was booked
  db.patch("order", o.id, { status: "PENDING" });
  await verifyViaService(o.id, "WALLETGATE", 100);
  assert.equal(Number(row(o.id).advanceRequired), 100);
  await move(o.id, "CONFIRMED");
  assert.equal(row(o.id).status, "CONFIRMED");
  assert.equal((await bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config })).booked, true);
});

test("a PARTIAL verified advance (less than required) does not release the gate; cancelling is always possible", async () => {
  await on();
  history("u3", 3);
  const o = await order("u3", claim("TXPART0001"));
  await verifyViaService(o.id, "WALLETPART", 99.99);
  assert.deepEqual([Number(row(o.id).advancePaid), row(o.id).paymentStatus], [99.99, "PARTIALLY_PAID"]);
  await assert.rejects(move(o.id, "CONFIRMED"), /advance/);
  await move(o.id, "CANCELLED");
  assert.equal(row(o.id).status, "CANCELLED");
});

test("a waiver releases the advance gate; the low-trust review gate is separate and cannot be waived away", async () => {
  await on();
  const o = await order(null, claim("TXREV00001"));                                // new customer: review required
  assert.equal(row(o.id).trustReviewRequired, true);
  await waiveAdvance({ orderId: o.id, adminId: "a1", reason: "Phoned the customer, will pay on delivery" });
  await assert.rejects(move(o.id, "CONFIRMED"), /staff review/);
  for (const to of ["PROCESSING", "SHIPPED"]) await assert.rejects(move(o.id, to));
  await assert.rejects(reviewTrustOrder({ orderId: o.id, adminId: "a1", note: "" }), /what you checked/);
  await reviewTrustOrder({ orderId: o.id, adminId: "a1", note: "Called, address and phone confirmed" });
  assert.deepEqual([row(o.id).trustReviewedById, row(o.id).trustReviewNote], ["a1", "Called, address and phone confirmed"]);
  assert.ok(row(o.id).trustReviewedAt instanceof Date);
  const [ev] = audit("TRUST_REVIEWED");
  assert.deepEqual([ev.actorId, ev.entityId, (ev.detail as any).note], ["a1", o.id, "Called, address and phone confirmed"]);
  await assert.rejects(reviewTrustOrder({ orderId: o.id, adminId: "a2", note: "again" }), /already reviewed/);
  await move(o.id, "CONFIRMED");
  assert.equal(row(o.id).status, "CONFIRMED");
});

test("the review requirement cannot be bypassed through the status action, the service or courier booking; no review is needed outside the policy scope", async () => {
  await on();
  const o = await order(null, claim("TXBYPASS01"));
  await verifyViaService(o.id, "WALLETBYP1", 200);
  const { updateOrderStatusAction } = await import("@/server/actions/admin-order.actions");
  const viaAction = await admin(() => updateOrderStatusAction(o.id, "CONFIRMED" as never));
  assert.equal(viaAction.success, false);
  assert.match((viaAction as { message: string }).message, /staff review/);
  await assert.rejects(runAs({ sub: "cust-1" }, () => updateOrderStatusAction(o.id, "CONFIRMED" as never)));
  db.patch("order", o.id, { status: "CONFIRMED" });                                  // even from an inconsistent CONFIRMED state
  const p = fakeProvider();
  await assert.rejects(bookOrderWithCourier(o.id, { actor: TEST_ADMIN }, { provider: p, config }), /staff review/);
  assert.equal(p.bookCalls, 0);
  const free = await order(null, { deliveryZone: "DHAKA_CITY", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Dhaka" } });
  assert.equal(row(free.id).trustReviewRequired, false);                              // outside the policy scope: no advance, no review
  await move(free.id, "CONFIRMED");
});

test("the review rule is a decision made at checkout: switching it off later does not release an order that was flagged, and switching it on does not flag old orders", async () => {
  await on({ reviewEnabled: false });
  const unflagged = await order(null, claim("TXREV0FF01"));
  assert.equal(row(unflagged.id).trustReviewRequired, false);
  await on({ reviewEnabled: true });
  const flagged = await order(null, { ...claim("TXREV0N001"), email: "f@example.com" });
  assert.equal(row(flagged.id).trustReviewRequired, true);
  await on({ reviewEnabled: false });
  await verifyViaService(flagged.id, "WALLETREV1", 200);
  await assert.rejects(move(flagged.id, "CONFIRMED"), /staff review/);                // still flagged by ITS OWN snapshot
  await verifyViaService(unflagged.id, "WALLETREV2", 200);
  await on({ reviewEnabled: true });
  await move(unflagged.id, "CONFIRMED");                                              // never flagged: unaffected by the later switch
});

// ---- payment reconciliation ---------------------------------------------------------------------------------------------------------------------------
async function verifyViaService(orderId: string, ref: string, amount: number) {
  const payId = pays(orderId).find((p) => p.status === "PENDING")!.id as string;
  return admin(() => verifyAdvancePayment({ paymentId: payId, adminId: "a1", providerRef: ref, amount }));
}

test("paid amount, balance and status come from verified payment records: partial = PARTIALLY_PAID, completed = PAID", async () => {
  await on({ standardAmount: 5000, reducedAmount: 2500 });
  history("u1", 1);
  const o = await order("u1", claim("TXRECON001"), "p-cheap", 1);
  const total = Number(row(o.id).total);
  assert.equal(Number(row(o.id).advanceRequired), total);
  await verifyViaService(o.id, "WALLETREC1", Math.round((total - 1) * 100) / 100);
  assert.equal(row(o.id).paymentStatus, "PARTIALLY_PAID");                           // one taka short: never PAID
  db.insert("payment", { id: "extra", orderId: o.id, method: "NAGAD", status: "PENDING", kind: "ADVANCE", amount: 1, customerReference: "TXEXTRA001" });
  await verifyViaService(o.id, "WALLETREC2", 1);
  assert.deepEqual([Number(row(o.id).advancePaid), row(o.id).paymentStatus], [total, "PAID"]);
  const panel = (await getAdvancePanel(o.id))!;
  assert.deepEqual([panel.remaining, panel.drift], [0, false]);
});

test("a hand-typed payment status is ignored: the action re-derives it from records (PAID with no verified money stays UNPAID)", async () => {
  await on();
  const o = await order(null, claim("TXMANUAL01"));
  assert.equal((await admin(() => updatePaymentStatusAction(o.id, "PAID"))).success, true);
  assert.deepEqual([row(o.id).paymentStatus, Number(row(o.id).advancePaid)], ["UNPAID", 0]);
  await assert.rejects(runAs({ sub: "cust-1" }, () => updatePaymentStatusAction(o.id, "PAID")));
  await verifyViaService(o.id, "WALLETMAN1", 200);
  await admin(() => updatePaymentStatusAction(o.id, "PAID"));
  assert.equal(row(o.id).paymentStatus, "PARTIALLY_PAID");
});

test("recorded refunds derive PARTIALLY_REFUNDED / REFUNDED; refunds can never exceed the money that was paid; no money paid -> no refund status", async () => {
  await on();
  const o = await order(null, claim("TXREFUND01"));
  await verifyViaService(o.id, "WALLETREF1", 200);
  await move(o.id, "CANCELLED");
  await admin(() => recordIncident({ kind: "REFUND", occurredOn: dhakaDay(), orderId: o.id, quantity: 0, stockEffect: "NONE", lossAmount: 0, refundAmount: 50, courierFee: 0 } as never, "a1"));
  assert.equal(row(o.id).paymentStatus, "PARTIALLY_REFUNDED");
  assert.equal(Number(row(o.id).advancePaid), 200);                                   // cash received is history; the refund is a separate record
  await admin(() => recordIncident({ kind: "REFUND", occurredOn: dhakaDay(), orderId: o.id, quantity: 0, stockEffect: "NONE", lossAmount: 0, refundAmount: 150, courierFee: 0 } as never, "a1"));
  assert.equal(row(o.id).paymentStatus, "REFUNDED");
  const unpaid = await order(null, { ...claim("TXREFUND02"), email: "r2@example.com" });
  await move(unpaid.id, "CANCELLED");
  await admin(() => recordIncident({ kind: "REFUND", occurredOn: dhakaDay(), orderId: unpaid.id, quantity: 0, stockEffect: "NONE", lossAmount: 0, refundAmount: 10, courierFee: 0 } as never, "a1"));
  assert.equal(row(unpaid.id).paymentStatus, "UNPAID");
});

test("cancellation keeps verified advances as money received (they leave only through a recorded refund); the order is no longer gated", async () => {
  await on();
  const o = await order(null, claim("TXCANCEL01"));
  await verifyViaService(o.id, "WALLETCAN1", 200);
  await move(o.id, "CANCELLED");
  assert.deepEqual([row(o.id).status, Number(row(o.id).advancePaid), row(o.id).paymentStatus], ["CANCELLED", 200, "PARTIALLY_PAID"]);
});

test("reconciliation never erases recorded money: a cached advance with no verified rows (legacy) is kept and reported as drift", async () => {
  db.insert("order", { id: "legacy", orderNumber: "AP-LEG", status: "PENDING", total: 1000, subtotal: 1000, advanceRequired: 200, advancePaid: 200, phone: "0" });
  const r = await prisma.$transaction((tx) => syncOrderPayment(tx, "legacy"));
  assert.deepEqual([r.drift, r.paid, r.status], [true, 200, "PARTIALLY_PAID"]);
  assert.equal(Number(row("legacy").advancePaid), 200);
  assert.equal((await getAdvancePanel("legacy"))!.drift, true);
  db.insert("payment", { id: "lp", orderId: "legacy", method: "BKASH", status: "PAID", kind: "ADVANCE", amount: 300, providerRef: "LEGACYREF1" });   // a verified row the cache missed
  const fixed = await prisma.$transaction((tx) => syncOrderPayment(tx, "legacy"));
  assert.deepEqual([fixed.paid, fixed.status], [300, "PARTIALLY_PAID"]);
});

// ---- customers never see our decisions --------------------------------------------------------------------------------------------------------------
test("customers never receive the score, the snapshot, waivers, reviews or audit data — not in an order view and not in the account dashboard", async () => {
  await on();
  const o = await order("cust-1", claim("TXEXPOSE01"));
  await waiveAdvance({ orderId: o.id, adminId: "a1", reason: "Trusted wholesale buyer" });
  await reviewTrustOrder({ orderId: o.id, adminId: "a1", note: "internal note: called" });
  const view = JSON.stringify(await runAs({ sub: "cust-1" }, () => getOrderByNumberForCurrentUser(o.orderNumber)));
  const overview = JSON.stringify(await runAs({ sub: "cust-1" }, () => getAccountOverview()));
  for (const json of [view, overview]) {
    for (const leaked of ["trustScore", "trustSnapshot", "advanceWaived", "Trusted wholesale buyer", "trustReview", "internal note", "scoreMeaning", "reducedFrom", "AdminAuditEvent"]) assert.ok(!json.includes(leaked), `leaked ${leaked}`);
  }
  assert.ok(view.includes(o.orderNumber));
});

// ---- COD collection is a record, not a typed-in label ----------------------------------------------------------------------------------------------
const toDelivered = async (id: string) => { for (const to of ["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) await move(id, to); };

test("delivery records the COD balance as an explicit payment: status becomes PAID from records, advancePaid stays 'advances only', accounting counts the money once", async () => {
  await on();
  history("u3", 3);
  const o = await order("u3", claim("TXCOD00001"), "p-standard", 2);
  await verifyViaService(o.id, "WALLETCOD1", 100);
  assert.deepEqual([row(o.id).paymentStatus, Number(row(o.id).advancePaid)], ["PARTIALLY_PAID", 100]);
  await toDelivered(o.id);
  const total = Number(row(o.id).total);
  const bal = pays(o.id).filter((p) => p.kind === "BALANCE");
  assert.deepEqual(bal.map((p) => [p.method, p.status, Number(p.amount)]), [["COD", "PAID", total - 100]]);
  assert.deepEqual([row(o.id).paymentStatus, Number(row(o.id).advancePaid)], ["PAID", 100]);
  const s = (await admin(() => getAccounting({ from: dhakaDay(-1), to: dhakaDay() }))).summary;
  assert.deepEqual([s.advancesReceived, s.codCollected, s.cashIn], [100, total - 100, total]);   // 100 + (total - 100): never 100 + total
  // a refund recorded afterwards is derived, the collection record stays history
  await admin(() => recordIncident({ kind: "REFUND", occurredOn: dhakaDay(), orderId: o.id, quantity: 0, stockEffect: "NONE", lossAmount: 0, refundAmount: 50, courierFee: 0 } as never, "a1"));
  assert.equal(row(o.id).paymentStatus, "PARTIALLY_REFUNDED");
});

test("COD is recorded once; a fully prepaid order records nothing; marketplace orders are settled by payouts, not by a COD record", async () => {
  await on({ standardAmount: 5000, reducedAmount: 2500 });
  history("u1", 1);
  const prepaid = await order("u1", claim("TXCOD00002"), "p-cheap", 1);                          // advance capped at the total
  await verifyViaService(prepaid.id, "WALLETCOD2", Number(row(prepaid.id).total));
  await toDelivered(prepaid.id);
  assert.equal(pays(prepaid.id).filter((p) => p.kind === "BALANCE").length, 0);
  assert.equal(row(prepaid.id).paymentStatus, "PAID");
  const { recordCodCollection } = await import("@/server/services/advance.service");
  await prisma.$transaction((tx) => recordCodCollection(tx, prepaid.id));                         // a repeat changes nothing
  assert.equal(pays(prepaid.id).filter((p) => p.kind === "BALANCE").length, 0);

  db.insert("salesChannel", { id: "channel_daraz", key: "daraz", name: "Daraz", kind: "MARKETPLACE" });
  const m = await admin(() => createExternalOrder({
    channelId: "channel_daraz", externalOrderRef: "d-1", customer: { fullName: "Jo Doe", phone: "01711000000", line1: "House 1, Road 2" },
    items: [{ productId: "p-standard", quantity: 1, unitPrice: 1500 }], shippingTotal: 60, costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 100 }], status: "DELIVERED",
  } as never, "a1"));
  assert.equal(pays(m.id).filter((p) => p.kind === "BALANCE").length, 0);
  const plain = await admin(() => createExternalOrder({
    channelId: "channel_fb", externalOrderRef: "f-1", customer: { fullName: "Jo Doe", phone: "01711000000", line1: "House 1, Road 2" },
    items: [{ productId: "p-standard", quantity: 1, unitPrice: 1500 }], shippingTotal: 60, costLines: [], status: "DELIVERED", advanceReceived: 500, advanceMethod: "COD",
  } as never, "a1"));
  assert.deepEqual([pays(plain.id).filter((p) => p.kind === "BALANCE").map((p) => Number(p.amount)), row(plain.id).paymentStatus, Number(row(plain.id).advancePaid)], [[1060], "PAID", 500]);
});
