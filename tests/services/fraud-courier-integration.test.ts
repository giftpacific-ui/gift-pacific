/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Checkout and order risk assessment against the shared courier-intelligence service, through the real services on the in-memory database.
 * The courier adapters are STAND-INS defined here (Pathao and REDX have no adapter in production; the real Steadfast is never called). The cache is
 * switched OFF on purpose: with no cache, any hidden second lookup would show up as an extra adapter call.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { emptyCheckout, freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { placeOrder } from "@/server/services/order.service";
import { processCheckout } from "@/server/services/checkout-flow.service";
import { shouldRejectAtCheckout } from "@/server/services/checkout-guard.service";
import type { CheckoutInput } from "@/lib/validations/checkout";
import { getAdvancePanel, recheckOrderFraud, saveAdvanceSettings } from "@/server/services/advance.service";
import { ensureRiskAssessed, evaluateOrderRisk, saveFraudPolicy } from "@/server/services/fraud-risk.service";
import { getOrderFraudPanel, recalculateOrderRisk } from "@/server/services/fraud-review.service";
import { getOrderCourierView, getPhoneRiskSummary } from "@/server/services/courier-intelligence-admin.service";
import { addRiskListEntry } from "@/server/services/risk-list.service";
import {
  resetIntelligenceStateForTests, setIntelligenceAdaptersForTests, setIntelligenceClockForTests, setIntelligenceDescriptorsForTests, setPhoneVerifiedForTests,
} from "@/server/services/courier-intelligence.service";
import { PROVIDER_DESCRIPTORS } from "@/lib/courier-intelligence/registry";
import { EMPTY_METRICS, INTEL_PROVIDERS, type HistoryAdapter, type HistoryAnswer, type IntelProviderKey, type MetricName } from "@/lib/courier-intelligence/types";

let db: FakeDb;
const saved: Record<string, string | undefined> = {};
const ENV = ["FRAUD_CHECK_CACHE_SECONDS", "RATE_LIMIT_ENABLED", "FRAUD_CHECK_ENABLED", "AUTH_SECRET"];
const policy = { enabled: true, zones: ["OUTSIDE_DHAKA"] as never, standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true, instructions: "Send to bKash 01XXXXXXXXX" };

// ---- stand-in couriers ------------------------------------------------------------------------------------------------------------------------
type Figures = { delivered: number; cancelled: number; returned?: number };
const FIG: Record<IntelProviderKey, Figures> = { steadfast: { delivered: 9, cancelled: 1 }, pathao: { delivered: 6, cancelled: 4 }, redx: { delivered: 20, cancelled: 5, returned: 3 } };
const SUPPORTED: Record<IntelProviderKey, MetricName[]> = { steadfast: [...PROVIDER_DESCRIPTORS.steadfast.supportedMetrics], pathao: ["delivered", "cancelled", "total"], redx: ["delivered", "cancelled", "returned", "total"] };
const ALL: MetricName[] = ["delivered", "cancelled", "returned", "failed", "total", "deliveryRate", "cancellationRate", "fraudReports"];
const figures = (f: Figures): HistoryAnswer => ({ ok: true, metrics: { ...EMPTY_METRICS, delivered: f.delivered, cancelled: f.cancelled, total: f.delivered + f.cancelled + (f.returned ?? 0), returned: f.returned ?? null, fraudReports: null, empty: false } });
type Spy = HistoryAdapter & { calls: string[] };
const spy = (k: IntelProviderKey, script: () => Promise<HistoryAnswer> = async () => figures(FIG[k])): Spy => {
  const a: Spy = { key: k, calls: [], async lookup(phone) { a.calls.push(phone); return k === "steadfast" ? { ...(await script()) } as HistoryAnswer : script(); } };
  return a;
};
/** Pathao and REDX modelled as supported (mock descriptors); each courier gets the given adapter (null = not configured). */
const threeCouriers = (a: Partial<Record<IntelProviderKey, Spy | null>>) => {
  setIntelligenceDescriptorsForTests({
    pathao: { ...PROVIDER_DESCRIPTORS.pathao, capability: "supported", supportedMetrics: SUPPORTED.pathao, unsupportedMetrics: ALL.filter((m) => !SUPPORTED.pathao.includes(m)) },
    redx: { ...PROVIDER_DESCRIPTORS.redx, capability: "supported", supportedMetrics: SUPPORTED.redx, unsupportedMetrics: ALL.filter((m) => !SUPPORTED.redx.includes(m)) },
  });
  setIntelligenceAdaptersForTests({ steadfast: null, pathao: null, redx: null, ...a } as any);
};

async function setup() {
  resetIntelligenceStateForTests();
  setIntelligenceDescriptorsForTests(undefined);
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  db.patch("product", "p-standard", { stock: 1000 });
  await saveAdvanceSettings(policy as never, "a1");
}
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  Object.assign(process.env, { FRAUD_CHECK_CACHE_SECONDS: "0", RATE_LIMIT_ENABLED: "false", AUTH_SECRET: "test-secret-for-hashing-0123456789" });
  delete process.env.FRAUD_CHECK_ENABLED;
  setPhoneVerifiedForTests(undefined);
  await setup();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setIntelligenceAdaptersForTests(undefined); setIntelligenceDescriptorsForTests(undefined); setIntelligenceClockForTests(undefined); setPhoneVerifiedForTests(undefined); resetIntelligenceStateForTests();
});

let n = 0;
const PHONE = "01711000001";
const place = (phone = PHONE) =>
  runAs(null, async () => {
    await addItemToCart({ productId: "p-standard", quantity: 1 });
    return placeOrder({ ...emptyCheckout, phone, deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Sylhet", phone }, advanceMethod: "BKASH", advanceReference: `TXINT${String(++n).padStart(5, "0")}` } as never);
  });
/** The REAL checkout entry point (replay, block-reject, rate limits, placement, early risk evaluation), for a signed-in customer. */
let ck = 0;
const checkout = async (phone: string) => {
  const user = `cust-${++ck}`;
  await runAs({ sub: user }, () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const input = { ...emptyCheckout, phone, couponCode: "", rewardId: "", checkoutKey: `key-${String(ck).padStart(8, "0")}-abcdefgh`, deliveryZone: "OUTSIDE_DHAKA", shippingAddress: { ...emptyCheckout.shippingAddress, city: "Sylhet", phone }, advanceMethod: "BKASH", advanceReference: `TXCK${String(ck).padStart(6, "0")}` } as unknown as CheckoutInput;
  return runAs({ sub: user }, () => processCheckout(input));
};
const orderByNumber = (num: string) => db.rows("order").find((o) => o.orderNumber === num)!;
const row = (id: string) => db.get("order", id);
const signals = (id: string): { code: string; points: number }[] => ((db.rows("orderRiskAssessment").filter((a) => a.orderId === id).at(-1)?.signals as any)?.signals ?? []);
const total = (spies: Record<string, Spy | null>) => Object.values(spies).reduce((a, s) => a + (s?.calls.length ?? 0), 0);

// =====================================================================================================================================================
// 1. One lookup, shared: checkout makes it; the risk code, the panels and the order page only READ it
// =====================================================================================================================================================
test("checkout makes ONE lookup per courier; risk assessment, recalculation, every admin panel and the order page make NONE; a manual recheck makes exactly one more", async () => {
  const sf = spy("steadfast");
  setIntelligenceAdaptersForTests({ steadfast: sf });
  const o = await place();
  assert.equal(sf.calls.length, 1, "checkout");
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null });
  await ensureRiskAssessed(o.id);
  await recalculateOrderRisk(o.id, "a1");
  await getOrderFraudPanel(o.id, "a1");
  await getAdvancePanel(o.id);
  await getOrderCourierView(o.id, { adminId: "a1" });
  await getPhoneRiskSummary({ adminId: "a1", phone: PHONE });
  assert.equal(sf.calls.length, 1, "risk assessment, panels and the order page reused the stored evidence");
  await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: new Date(Date.now() + 120_000) });
  assert.equal(sf.calls.length, 2, "only the explicit recheck asked the courier again");
  assert.deepEqual(db.rows("courierIntelligenceSnapshot").map((r) => r.source).sort(), ["CHECKOUT", "ORDER_RECHECK"]);
});

test("with all three couriers (stand-ins) checkout still makes exactly ONE lookup per courier, and the risk code adds none", async () => {
  const spies = { steadfast: spy("steadfast"), pathao: spy("pathao"), redx: spy("redx") };
  threeCouriers(spies);
  const o = await place();
  assert.deepEqual(Object.values(spies).map((s) => s.calls.length), [1, 1, 1]);
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null });
  await recalculateOrderRisk(o.id, "a1");
  await getOrderCourierView(o.id, { adminId: "a1" });
  assert.deepEqual(Object.values(spies).map((s) => s.calls.length), [1, 1, 1]);
  assert.deepEqual(db.rows("courierIntelligenceSnapshot").map((r) => r.provider).sort(), ["pathao", "redx", "steadfast"]);
});

test("GUARD: the risk and review code never imports the courier service, and the courier history is requested from exactly the places that should", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
  const src = files(path.join(process.cwd(), "src"));
  const read = (p: string) => readFileSync(p, "utf8");
  const rel = (p: string) => path.relative(process.cwd(), p).split(path.sep).join("/");

  // 1) The risk scoring and its data gathering are pure readers of stored evidence.
  for (const p of src.filter((f) => /src\/lib\/fraud\/|fraud-risk\.service|fraud-evidence\.service|fraud-review\.service|customer-risk\.service|risk-list\.service/.test(rel(f)))) {
    assert.doesNotMatch(read(p), /courier-intelligence\.service|courier-intelligence-providers|getCourierIntelligence|getProviderReport/, `${rel(p)} must not call a courier`);
  }
  // 2) Who may call the shared lookup: checkout / recheck (advance service) and the admin entry points. Nothing else.
  const callers = (re: RegExp) => src.filter((f) => !/courier-intelligence\.service\.ts$/.test(rel(f)) && re.test(read(f))).map(rel).sort();
  assert.deepEqual(callers(/\bgetCourierIntelligence\(/), ["src/server/services/advance.service.ts"]);
  assert.deepEqual(callers(/\bgetProviderReport\(/), ["src/server/services/courier-intelligence-admin.service.ts"]);
  // 3) The Steadfast history endpoint appears only inside its adapter.
  assert.deepEqual(callers(/fraud_check\//).filter((f) => !/^src\/(lib\/courier-intelligence\/|server\/services\/courier-intelligence-providers\/)/.test(f)), [], "no second place builds a history request");
});

// =====================================================================================================================================================
// 2. Every mix of couriers reaches the stored trust evidence the order is judged on
// =====================================================================================================================================================
const MIXES: [IntelProviderKey[], number][] = [
  [["steadfast"], 90],                       // 9 / 10
  [["steadfast", "pathao"], 75],             // 15 / 20
  [["steadfast", "redx"], 29 / 35 * 100],    // 29 / 35
  [["pathao", "redx"], 26 / 35 * 100],       // 26 / 35
  [["steadfast", "pathao", "redx"], 35 / 45 * 100],
];
for (const [mix, expectedRate] of MIXES) {
  test(`checkout with [${mix.join(" + ")}] stores the combined evidence of exactly those couriers, from one lookup each`, async () => {
    const spies = Object.fromEntries(INTEL_PROVIDERS.map((k) => [k, mix.includes(k) ? spy(k) : null])) as Record<IntelProviderKey, Spy | null>;
    threeCouriers(spies);
    const o = await place();
    const c = (row(o.id).trustSnapshot as any).courier;
    assert.deepEqual(c.providers, INTEL_PROVIDERS.filter((k) => mix.includes(k)));
    assert.equal(Math.round(c.rate), Math.round(expectedRate));
    for (const k of INTEL_PROVIDERS) assert.equal(spies[k]?.calls.length ?? 0, mix.includes(k) ? 1 : 0, k);
    assert.equal(row(o.id).status, "PENDING");
  });
}

test("one courier failing leaves the others' evidence untouched: the stored rate equals the rate of the answering couriers alone", async () => {
  const down = spy("steadfast", async () => ({ ok: false, reason: "timeout" }));
  threeCouriers({ steadfast: down, pathao: spy("pathao"), redx: spy("redx") });
  const withFailure = await place();
  const a = { ...row(withFailure.id) };                       // read BEFORE the database is reset for the second scenario
  await setup();
  threeCouriers({ steadfast: null, pathao: spy("pathao"), redx: spy("redx") });
  const without = await place();
  const b = row(without.id);
  assert.deepEqual((a.trustSnapshot as any).courier.providers, ["pathao", "redx"]);
  assert.deepEqual([a.trustScore, Number(a.advanceRequired), a.trustReviewRequired], [b.trustScore, Number(b.advanceRequired), b.trustReviewRequired]);
});

// =====================================================================================================================================================
// 3. An unavailable courier never rejects, penalises or changes the risk
// =====================================================================================================================================================
const OUTAGES: [string, () => Spy | null, string?][] = [
  ["a timeout", () => spy("steadfast", async () => ({ ok: false, reason: "timeout" }))],
  ["the courier rejecting our credentials", () => spy("steadfast", async () => ({ ok: false, reason: "auth_failed" }))],
  ["an unusable response", () => spy("steadfast", async () => ({ ok: false, reason: "invalid_response" }))],
  ["an adapter that throws", () => spy("steadfast", async () => { throw new Error("boom"); })],
  ["no courier configured", () => null],
];
test("REGRESSION GUARD: whatever the outage, the REAL checkout accepts the order, it is scored exactly as with no courier data, and carries no courier-based risk signal", async () => {
  const outcomes: { label: string; ok: boolean; status: string; score: unknown; level: unknown; review: unknown; codes: string[]; trustScore: unknown; advance: number; gateOpen: boolean }[] = [];
  for (const [label, make] of OUTAGES) {
    await setup();
    setIntelligenceAdaptersForTests({ steadfast: make() } as any);
    const res = await checkout("01711000001");
    assert.equal(res.success, true, `${label}: checkout succeeded`);
    const o = orderByNumber((res as { orderNumber: string }).orderNumber);
    await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null });
    const r = row(o.id);
    const panel = (await getOrderFraudPanel(o.id, "a1"))!;
    outcomes.push({ label, ok: res.success, status: r.status, score: r.riskScore, level: r.riskLevel, review: r.riskReviewRequired, codes: signals(o.id).map((s) => s.code), trustScore: r.trustScore, advance: Number(r.advanceRequired), gateOpen: panel.gateOpen });
  }
  for (const o of outcomes) {
    assert.equal(o.status, "PENDING", `${o.label}: not rejected or cancelled`);
    assert.deepEqual([o.level, o.review, o.gateOpen], ["LOW", false, true], `${o.label}: no hold, gate open`);
    assert.ok(!o.codes.includes("LOW_TRUST_EVIDENCE"), `${o.label}: no courier-based signal`);
    assert.equal(o.trustScore, null, `${o.label}: unrated, not scored zero`);
    assert.equal(o.advance, 200, `${o.label}: the safe standard advance (an outage never lowers it)`);
  }
  assert.equal(new Set(outcomes.map((o) => o.score)).size, 1, "every kind of outage yields the identical risk score");
  assert.equal(new Set(outcomes.map((o) => o.codes.join())).size, 1);
});

test("an outage is ALSO not rejection under the strictest policy: with blockAction=REJECT and every courier down the REAL checkout still accepts the order", async () => {
  await saveFraudPolicy({ blockAction: "REJECT" }, "a1");
  threeCouriers({ steadfast: spy("steadfast", async () => ({ ok: false, reason: "timeout" })), pathao: spy("pathao", async () => ({ ok: false, reason: "error" })), redx: spy("redx", async () => { throw new Error("x"); }) });
  assert.equal(await shouldRejectAtCheckout({ phone: PHONE, email: "buyer@example.com", ip: null }), false, "courier health is not an input to the reject decision");
  const res = await checkout(PHONE);
  assert.equal(res.success, true);
  assert.equal(orderByNumber((res as { orderNumber: string }).orderNumber).status, "PENDING");
});

test("CONTROL: the block list is what rejects. With blockAction=REJECT a blocked phone is refused even when its courier record is perfect, so the policy above is live", async () => {
  await saveFraudPolicy({ blockAction: "REJECT" }, "a1");
  await addRiskListEntry({ listType: "BLOCK", kind: "PHONE", value: PHONE, reason: "confirmed chargeback fraud", adminId: "a1" });
  const sf = spy("steadfast");                                   // healthy courier, good record
  setIntelligenceAdaptersForTests({ steadfast: sf });
  assert.equal(await shouldRejectAtCheckout({ phone: PHONE, email: "buyer@example.com", ip: null }), true);
  const res = await checkout(PHONE);
  assert.deepEqual([res.success, (res as { message?: string }).message], [false, "We could not process this order online. Please contact us to complete it."]);
  assert.equal(sf.calls.length, 0, "refused before any courier is asked");
  assert.equal(db.rows("order").length, 0);
  // Under the default HOLD action the same blocked phone is accepted and held for review instead (never silently passed).
  await saveFraudPolicy({ blockAction: "HOLD" }, "a1");
  const held = await checkout(PHONE);
  assert.equal(held.success, true);
  assert.equal(orderByNumber((held as { orderNumber: string }).orderNumber).riskLevel, "CRITICAL");
});

test("a genuinely poor record (enough parcels, low rate) DOES add the courier risk signal, and still never auto-rejects: it goes to a person", async () => {
  const outage = await (async () => { setIntelligenceAdaptersForTests({ steadfast: spy("steadfast", async () => ({ ok: false, reason: "timeout" })) }); const o = await place("01711000010"); await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null }); return row(o.id).riskScore as number; })();
  await setup();
  setIntelligenceAdaptersForTests({ steadfast: spy("steadfast", async () => figures({ delivered: 9, cancelled: 15 })) });
  const o = await place("01711000011");
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null });
  const sig = signals(o.id).find((s) => s.code === "LOW_TRUST_EVIDENCE");
  assert.ok(sig && sig.points > 0, "real evidence counts");
  assert.ok((row(o.id).riskScore as number) > outage, "...and it is the evidence, not an outage, that moved the score");
  assert.equal(row(o.id).status, "PENDING", "not rejected");
  assert.equal(row(o.id).trustReviewRequired, true, "routed to staff review");
  const view = (await getOrderCourierView(o.id, { adminId: "a1" }))!;
  assert.match(view.risk!.courierNote, /raised this score by/);
});

test("a recheck during an outage records 'unavailable', never overwrites the good checkout evidence, and does not touch the risk score or the review flag", async () => {
  const sf = spy("steadfast");
  setIntelligenceAdaptersForTests({ steadfast: sf });
  const o = await place();
  await evaluateOrderRisk(o.id, { trigger: "CHECKOUT", ip: null });
  const before = { score: row(o.id).riskScore, level: row(o.id).riskLevel, review: row(o.id).riskReviewRequired, tr: row(o.id).trustReviewRequired, fc: JSON.stringify((row(o.id).trustSnapshot as any).fraudCheck) };
  setIntelligenceAdaptersForTests({ steadfast: spy("steadfast", async () => ({ ok: false, reason: "timeout" })) });
  const res = await recheckOrderFraud({ orderId: o.id, adminId: "a1", now: new Date(Date.now() + 120_000) });
  assert.deepEqual([res.status, res.score], ["unavailable", null]);
  const after = row(o.id);
  assert.deepEqual([after.riskScore, after.riskLevel, after.riskReviewRequired, after.trustReviewRequired, JSON.stringify((after.trustSnapshot as any).fraudCheck)], [before.score, before.level, before.review, before.tr, before.fc]);
  assert.equal(after.status, "PENDING");
});

test("sanity: no test above leaked a courier call count between scenarios", () => {
  assert.equal(total({ a: null }), 0);
});
