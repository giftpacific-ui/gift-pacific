/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Where the courier report meets the rest of the system: the order page panel, the fraud-review customer lookup, and the rules that a courier report
 * never rejects, cancels, confirms or dispatches anything by itself. Courier adapter = a STAND-IN defined in this file.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { placeOrder, adminUpdateOrderStatus } from "@/server/services/order.service";
import { assertDispatchReady, recheckOrderFraud, saveAdvanceSettings } from "@/server/services/advance.service";
import { getOrderIntelligencePanel } from "@/server/services/courier-intelligence-admin.service";
import { getStoredIntelligence, resetIntelligenceStateForTests, setIntelligenceAdaptersForTests, setIntelligenceClockForTests } from "@/server/services/courier-intelligence.service";
import { getCustomerRiskProfile } from "@/server/services/customer-risk.service";
import { prisma } from "@/lib/db/prisma";
import { EMPTY_METRICS } from "@/lib/courier-intelligence/types";

let db: FakeDb;
let calls: string[] = [];
const records = new Map<string, { delivered: number; cancelled: number }>();
const PHONE = "01711000001";
const ENV = ["FRAUD_CHECK_CACHE_SECONDS", "RATE_LIMIT_ENABLED"];
const saved: Record<string, string | undefined> = {};
const policy = { enabled: true, zones: ["OUTSIDE_DHAKA"] as never, standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true, instructions: "Send to bKash 01XXXXXXXXX" };

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.FRAUD_CHECK_CACHE_SECONDS = "600"; process.env.RATE_LIMIT_ENABLED = "false";
  calls = []; records.clear();
  resetIntelligenceStateForTests();
  setIntelligenceAdaptersForTests({
    steadfast: {
      key: "steadfast",
      lookup: async (phone: string) => {
        calls.push(phone);
        const r = records.get(phone) ?? { delivered: 0, cancelled: 0 };
        const total = r.delivered + r.cancelled;
        return { ok: true as const, metrics: { ...EMPTY_METRICS, delivered: r.delivered, cancelled: r.cancelled, total, fraudReports: 0, empty: total === 0 } };
      },
    },
  });
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.insert("salesChannel", { id: "channel_website", key: "website", name: "Website", kind: "WEBSITE" });
  db.patch("product", "p-standard", { stock: 100 });
  await saveAdvanceSettings(policy as never, "a1");
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setIntelligenceAdaptersForTests(undefined); setIntelligenceClockForTests(undefined); resetIntelligenceStateForTests();
});

let n = 0;
const place = (phone = PHONE, user: string | null = null) => runAs(user ? { sub: user } : null, async () => {
  await addItemToCart({ productId: "p-standard", quantity: 1 });
  return placeOrder({ ...emptyCheckout, deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Sylhet", phone }, advanceMethod: "BKASH", advanceReference: `TXINTEG${String(++n).padStart(5, "0")}` } as never);
});
const row = (id: string) => db.get("order", id);
const snaps = () => db.rows("courierIntelligenceSnapshot");

test("order page: the panel shows the saved courier report for the DELIVERY phone, the frozen checkout evidence and the internal history separately, and opening it calls no courier", async () => {
  records.set(PHONE, { delivered: 8, cancelled: 2 });
  const o = await place();
  assert.equal(calls.length, 1);
  const panel = (await getOrderIntelligencePanel(o.id))!;
  assert.equal(calls.length, 1);                                   // reading the panel is free: no courier call
  assert.equal(panel.phoneMasked, "017*****001");
  assert.deepEqual([panel.stored!.combined.state, panel.stored!.combined.deliverySuccessRate, panel.stored!.combined.delivered, panel.stored!.combined.cancelled], ["valid", 80, 8, 2]);
  assert.deepEqual(panel.stored!.reports.map((r) => [r.provider, r.status]), [["steadfast", "ok"], ["pathao", "unsupported"], ["redx", "unsupported"]]);
  assert.deepEqual([panel.atCheckout!.state, panel.atCheckout!.rate, panel.atCheckout!.sample, panel.atCheckout!.providers], ["rated", 80, 10, ["steadfast"]]);
  assert.deepEqual([panel.rechecks.length, panel.unchecked], [0, []]);
  // B: internal history counts only this website's own orders and is a different thing from A
  assert.equal(typeof panel.internal?.total, "number");
  assert.ok(!JSON.stringify(panel).includes(PHONE));              // only the masked number leaves the service
});

test("the lookup phone is the delivery phone in the order's shipping snapshot, not the account or contact phone", async () => {
  records.set("01811000009", { delivered: 6, cancelled: 0 });
  const o = await place("01811000009");
  db.patch("order", o.id, { phone: "01999999999" });                // a different contact phone
  const panel = (await getOrderIntelligencePanel(o.id))!;
  assert.equal(panel.phoneMasked, "018*****009");
  assert.equal(panel.stored!.combined.delivered, 6);
});

test("a manual recheck stores a NEW timestamped result and preserves the previous check; the order-time evidence stays frozen", async () => {
  records.set(PHONE, { delivered: 8, cancelled: 2 });
  const o = await place();
  assert.equal(snaps().length, 1);
  const first = JSON.stringify(snaps()[0]);
  records.set(PHONE, { delivered: 8, cancelled: 12 });
  await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: new Date(Date.now() + 120_000) });
  assert.equal(snaps().length, 2);                                  // a new row; nothing overwritten
  assert.equal(JSON.stringify(snaps().find((s) => s.source === "CHECKOUT")), first);
  assert.equal(snaps().filter((s) => s.source === "ORDER_RECHECK").length, 1);
  const panel = (await getOrderIntelligencePanel(o.id))!;
  assert.deepEqual([panel.atCheckout!.rate, panel.stored!.combined.deliverySuccessRate, panel.rechecks.length, panel.rechecks[0].rate], [80, 40, 1, 40]);
  assert.equal(panel.rechecks[0].byId, "a1");
});

test("the panel degrades honestly: no valid phone, nothing saved yet, or no courier configured", async () => {
  const o = await place("123456");
  const bad = (await getOrderIntelligencePanel(o.id))!;
  assert.deepEqual([bad.phoneMasked, bad.stored], [null, null]);
  assert.equal(await getOrderIntelligencePanel("nope"), null);
  setIntelligenceAdaptersForTests({ steadfast: null });
  const o2 = await place("01711000002");
  const none = (await getOrderIntelligencePanel(o2.id))!;
  assert.deepEqual(none.stored!.reports.map((r) => r.status), ["not_configured", "unsupported", "unsupported"]);
  assert.equal(none.stored!.combined.deliverySuccessRate, null);
  assert.equal(none.atCheckout!.state, "unavailable");
});

test("internal website history never feeds the courier rate: ten delivered website orders do not change an unrated courier result", async () => {
  db.insert("user", { id: "u-int", email: "int@x.test", name: "Int", role: "CUSTOMER", isActive: true });
  for (let i = 0; i < 10; i++) db.insert("order", { id: `old${i}`, orderNumber: `GP-OLD${i}`, userId: "u-int", status: "DELIVERED", channelId: "channel_website", phone: PHONE, phoneNorm: PHONE, advanceRequired: 0, advancePaid: 0, total: 500, createdAt: new Date(Date.now() - 86400000 * (i + 2)) });
  records.set(PHONE, { delivered: 1, cancelled: 0 });             // the couriers know almost nothing
  const o = await place(PHONE, "u-int");
  assert.deepEqual([row(o.id).trustScore, Number(row(o.id).advanceRequired)], [null, 200]);
  const panel = (await getOrderIntelligencePanel(o.id))!;
  assert.ok(panel.internal!.total >= 10);                           // B sees our own orders...
  assert.equal(panel.stored!.combined.finalOutcomes, 1);            // ...A never does
});

test("fraud review: the customer lookup gets the SAVED external report for the profile's phone, kept apart from internal history; no courier is called", async () => {
  records.set(PHONE, { delivered: 6, cancelled: 4 });
  const o = await place();
  calls = [];
  const profile = await getCustomerRiskProfile({ orderId: o.id });
  assert.ok(profile && profile.identity.phones.length > 0);
  // the profile knows both the contact phone (…000) and the delivery phone (…001); each is judged on its own, and only the delivery phone was checked
  const all = await Promise.all(profile!.identity.phones.slice(0, 3).map((ph) => getStoredIntelligence(ph)));
  assert.deepEqual(all.map((x) => x.phoneMasked).sort(), ["017*****000", "017*****001"]);
  const external = all.find((x) => x.phoneMasked === "017*****001")!;
  assert.deepEqual([calls.length, external.combined.deliverySuccessRate, external.unchecked], [0, 60, []]);
  assert.deepEqual(all.find((x) => x.phoneMasked === "017*****000")!.unchecked, ["steadfast"]);   // never checked: "not checked yet", not zero and not a failure
  assert.ok(typeof profile!.stats.total === "number");              // the internal history is a separate structure
});

test("a courier report never rejects, cancels, confirms or dispatches an order by itself, and the existing review gate still applies", async () => {
  records.set(PHONE, { delivered: 1, cancelled: 29 });              // a terrible 3.3% record
  const o = await place();
  const r = row(o.id);
  assert.equal(r.status, "PENDING");                                // not cancelled, not rejected
  assert.deepEqual([r.trustScore, Number(r.advanceRequired), r.trustReviewRequired], [3, 200, true]);
  assert.equal(db.rows("riskListEntry").length, 0);                 // no block list entry was created
  assert.notEqual(r.riskReviewDecision, "REJECTED");
  // the low-trust review is still required before dispatch, exactly as before P6 (a courier report is evidence, not a decision)
  await assert.rejects(() => assertDispatchReady(prisma, o.id), /advance payment to be verified/i);   // the advance is checked first, as before
  db.patch("order", o.id, { advancePaid: 200 });                                                          // ...once it is verified, the review is what still blocks dispatch
  await assert.rejects(() => assertDispatchReady(prisma, o.id), /review/i);
  db.patch("order", o.id, { trustReviewedAt: new Date() });
  await assert.doesNotReject(() => assertDispatchReady(prisma, o.id));                                      // only a recorded staff review releases it
});

test("a GOOD courier record never skips the advance verification or the dispatch gates", async () => {
  await saveAdvanceSettings({ ...policy, rewardEnabled: true, creditUnverifiedPhone: true } as never, "a1");
  records.set(PHONE, { delivered: 30, cancelled: 0 });
  const o = await place();
  assert.equal(Number(row(o.id).advanceRequired), 100);             // reduced, not zero
  assert.equal(row(o.id).paymentStatus, "UNPAID");                  // the claim is not money
  await assert.rejects(() => adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, { adminId: "a1" } as never), /advance/i);   // the advance still has to be verified
});

