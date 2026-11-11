import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressLooksLikeDhaka, computeTrust, normalizeBdPhone, DEFAULT_POLICY, decideAdvance, derivePayment, historyIsConsistent, policyZoneFor, sanitizePolicy, validateAdvancePolicy,
  type AdvancePolicy,
} from "@/lib/advance-policy";
import { readFileSync } from "node:fs";
import { aggregateParcels, isValidFraudHistory, type ParcelBucket } from "../../src/lib/fraud-check";
import { dispatchBlockedReason } from "@/server/services/advance.service";

const policy = (o: Partial<AdvancePolicy> = {}): AdvancePolicy => ({ ...DEFAULT_POLICY, enabled: true, zones: ["OUTSIDE_DHAKA"], ...o });
const decide = (score: number, o: Partial<AdvancePolicy> = {}, total = 5000, zone = "OUTSIDE_DHAKA", zoneConflict = false) => decideAdvance(policy(o), { zone, orderTotal: total, trustScore: score, zoneConflict });

// ---- the 60 / 80 / 100 policy: points on a 0-100 heuristic scale, compared with >= ---------------------------------------------------
test("boundary scores 0, 59, 60, 79, 80, 99, 100: tier, amount and review requirement", () => {
  const expect: [number, string, number, boolean][] = [
    [0, "low", 200, true], [59, "low", 200, true], [60, "standard", 200, false], [79, "standard", 200, false], [80, "reduced", 100, false], [99, "reduced", 100, false], [100, "full", 100, false],
  ];
  for (const [score, tier, amount, review] of expect) {
    const d = decide(score);
    assert.deepEqual([d.tier, d.required, d.needsReview], [tier, amount, review], `score ${score}`);
  }
});

test("100 gives ZERO advance only when the business explicitly enabled that rule; 99 never does", () => {
  assert.equal(decide(100).required, 100);                                  // default: the reduced advance still applies at full trust
  assert.equal(decide(100, { zeroAtFullTrust: true }).required, 0);
  assert.equal(decide(99, { zeroAtFullTrust: true }).required, 100);        // one point short of full: not zero
  assert.equal(decide(100, { zeroAtFullTrust: true }).tier, "full");
});

test("thresholds are configurable and the boundary moves with them (>=, never >)", () => {
  const p = { lowBelow: 70, reducedFrom: 90, fullAt: 100 };
  assert.deepEqual([decide(69, p).tier, decide(70, p).tier, decide(89, p).tier, decide(90, p).tier], ["low", "standard", "standard", "reduced"]);
  assert.equal(decide(60, p).needsReview, true);                            // 60 is no longer enough once the low threshold is 70
});

test("amounts are configurable; the advance never exceeds the order total, a zero total needs none, and the COD balance is total - advance", () => {
  assert.equal(decide(50, { standardAmount: 350 }, 5000).required, 350);
  assert.equal(decide(50, {}, 150).required, 150);                          // capped at the order amount
  assert.equal(decide(50, {}, 0).required, 0);
  assert.equal(decide(85, { reducedAmount: 40.5 }, 5000).required, 40.5);
  const adv = decide(50, {}, 1200).required;
  assert.equal(derivePayment({ total: 1200, advanceRequired: adv, waived: false, payments: [{ status: "PAID", amount: adv }] }).balance, 1000);
});

test("scope: disabled policy or an uncovered zone needs no advance and no review; configured zones are honoured", () => {
  assert.deepEqual([decide(10, { enabled: false }).required, decide(10, { enabled: false }).needsReview], [0, false]);
  assert.equal(decide(10, {}, 5000, "DHAKA_CITY").required, 0);
  assert.equal(decide(10, { zones: ["DHAKA_CITY", "OTHER"] }, 5000, "DHAKA_CITY").required, 200);
  assert.equal(decide(10, { zones: ["DHAKA_CITY", "OTHER"] }, 5000, "OUTSIDE_DHAKA").required, 0);
  assert.equal(decide(10, { reviewEnabled: false }).needsReview, false);    // the review rule can be switched off, explicitly
});

test("a non-finite or out-of-range score can never raise trust: NaN falls back to the conservative default, values are clamped to 0-100", () => {
  assert.equal(decide(Number.NaN).tier, "low");
  assert.equal(decide(Infinity).tier, "low");                                // not a finite number: never trusted
  assert.equal(decide(1e6).tier, "full");                                    // a large FINITE value is clamped to 100, the top of the scale
  assert.equal(decide(-40).tier, "low");
  assert.equal(decide(250, { zeroAtFullTrust: false }).required, 100);       // clamped to 100: reduced, not zero
});

test("explanations speak in points out of 100, never as a percentage or probability", () => {
  assert.match(decide(80).explanation, /Trust score 80\/100/);
  assert.doesNotMatch(decide(80).explanation, /%/);
});

// ---- trust computation (fraud check): conservative default and conflicting data ---------------------------------------------------------
test("no fraud-check record gets the conservative default; the score never leaves 0-100", () => {
  for (const h of [null, { delivered: 0, cancelled: 0 }]) {
    const t = computeTrust(h);
    assert.deepEqual([t.score, t.insufficientEvidence], [50, true]);
  }
  assert.equal(computeTrust({ delivered: 50, cancelled: 0 }, { phoneVerified: true }).score, 100);
  assert.equal(computeTrust({ delivered: 0, cancelled: 9 }, { phoneVerified: true }).score, 0);
});

test("conflicting or corrupt fraud-check data falls back to the default instead of granting trust", () => {
  assert.equal(computeTrust({ delivered: 5, cancelled: 0 }, { phoneVerified: true }).score, 100);
  for (const bad of [{ delivered: -1, cancelled: 0 }, { delivered: 2.5, cancelled: 0 }, { delivered: 1, cancelled: Number.NaN }, { delivered: 3, cancelled: -2 }]) {
    assert.equal(historyIsConsistent(bad), false);
    const t = computeTrust(bad, { phoneVerified: true });
    assert.deepEqual([t.score, t.insufficientEvidence], [50, true]);
    assert.match(t.reasons.join(" "), /inconsistent/);
  }
});

test("every reachable score is a multiple of 5 and within 0-100", () => {
  const seen = new Set<number>();
  for (let d = 0; d <= 8; d++) for (let c = 0; c <= 4; c++) for (const t of [true, false]) seen.add(computeTrust({ delivered: d, cancelled: c }, { phoneVerified: t }).score);
  for (const s of seen) { assert.ok(s >= 0 && s <= 100); assert.equal(s % 10, 0); }
});

test("phones are normalised consistently and non-mobile input is rejected", () => {
  for (const ok of ["01711000000", "+8801711000000", "8801711000000", "008801711000000", "+88 01711-000 000", "017-1100 0000"]) assert.equal(normalizeBdPhone(ok), "01711000000");
  for (const bad of [null, undefined, "", "12345", "01211000000", "0171100000", "abc", "+8801711000000999", "+8802711000000"]) assert.equal(normalizeBdPhone(bad as never), null);
});

// ---- validation -------------------------------------------------------------------------------------------------------------------------
test("policy validation: ordering, integers, amounts, zones", () => {
  assert.equal(validateAdvancePolicy(policy()), null);
  const bad: Partial<AdvancePolicy>[] = [
    { lowBelow: 0 }, { lowBelow: 90 }, { reducedFrom: 101, fullAt: 101 }, { fullAt: 79 }, { lowBelow: 60.5 }, { lowBelow: 80, reducedFrom: 80, fullAt: 80 },
    { standardAmount: -1 }, { standardAmount: Number.NaN }, { standardAmount: 100.123 }, { standardAmount: 1e9 }, { reducedAmount: 500 }, { zones: [] },
    { zones: ["MARS" as never] }, { standardAmount: 0, reducedAmount: 0 },
  ];
  for (const b of bad) assert.notEqual(validateAdvancePolicy(policy(b)), null, JSON.stringify(b));
  assert.equal(validateAdvancePolicy(policy({ standardAmount: 0, reducedAmount: 0, zeroAtFullTrust: true })), null);
  assert.equal(validateAdvancePolicy(policy({ enabled: false, zones: [] })), null);
});

test("stored settings that fail validation never weaken the policy: defaults apply and the problem is reported", () => {
  const broken = policy({ standardAmount: 5, reducedAmount: 900, lowBelow: 95, reducedFrom: 50 });
  const { policy: used, problem } = sanitizePolicy(broken);
  assert.ok(problem);
  assert.deepEqual([used.standardAmount, used.reducedAmount, used.lowBelow, used.reducedFrom, used.fullAt, used.zeroAtFullTrust], [200, 100, 60, 80, 100, false]);
  assert.equal(used.enabled, true);                                           // the on/off switch the admin chose is respected
  assert.equal(sanitizePolicy(policy()).problem, null);
});

// ---- delivery-zone evidence ---------------------------------------------------------------------------------------------------------------
test("a 'Dhaka City' claim with no Dhaka evidence in the address uses the stricter zone; real Dhaka addresses are untouched", () => {
  assert.equal(addressLooksLikeDhaka({ city: "Dhaka" }), true);
  assert.equal(addressLooksLikeDhaka({ city: "Mirpur", line1: "Road 5" }), true);
  assert.equal(addressLooksLikeDhaka({ city: "ঢাকা" }), true);
  assert.equal(addressLooksLikeDhaka({ city: "Chattogram", state: "Chattogram", line1: "Agrabad" }), false);
  assert.deepEqual(policyZoneFor("DHAKA_CITY", { city: "Sylhet" }), { zone: "OUTSIDE_DHAKA", conflict: true });
  assert.deepEqual(policyZoneFor("DHAKA_CITY", { city: "Dhaka" }), { zone: "DHAKA_CITY", conflict: false });
  assert.deepEqual(policyZoneFor("OUTSIDE_DHAKA", { city: "Dhaka" }), { zone: "OUTSIDE_DHAKA", conflict: false }); // a claim is only ever tightened, never loosened
  const d = decide(80, {}, 5000, "OUTSIDE_DHAKA", true);
  assert.equal(d.needsReview, true);
  assert.match(d.explanation, /zone does not match/);
});

// ---- payment derivation ----------------------------------------------------------------------------------------------------------------------
test("payment status is derived from VERIFIED records: a claim is nothing, a partial payment is never PAID, a waiver is not money", () => {
  const base = { total: 1000, advanceRequired: 200, waived: false };
  assert.deepEqual(pick(derivePayment({ ...base, payments: [{ status: "PENDING", amount: 200 }] })), { paid: 0, status: "UNPAID", balance: 1000, advanceStillRequired: 200, unverifiedClaims: 200 });
  assert.deepEqual(pick(derivePayment({ ...base, payments: [{ status: "PAID", amount: 200 }, { status: "FAILED", amount: 800 }] })), { paid: 200, status: "PARTIALLY_PAID", balance: 800, advanceStillRequired: 0, unverifiedClaims: 0 });
  assert.equal(derivePayment({ ...base, payments: [{ status: "PAID", amount: 999.99 }] }).status, "PARTIALLY_PAID");
  assert.equal(derivePayment({ ...base, payments: [{ status: "PAID", amount: 1000 }] }).status, "PAID");
  const waived = derivePayment({ ...base, waived: true, payments: [] });
  assert.deepEqual([waived.paid, waived.status, waived.advanceStillRequired, waived.balance], [0, "UNPAID", 0, 1000]);
  assert.equal(derivePayment({ ...base, payments: [{ status: "PAID", amount: 0.1 }, { status: "PAID", amount: 0.2 }] }).paid, 0.3);   // no float drift
});
const pick = (d: ReturnType<typeof derivePayment>) => ({ paid: d.paid, status: d.status, balance: d.balance, advanceStillRequired: d.advanceStillRequired, unverifiedClaims: d.unverifiedClaims });

test("refunds are explicit records: partial refund -> PARTIALLY_REFUNDED, full -> REFUNDED, never more than was paid, and no money -> no refund status", () => {
  const p = { total: 1000, advanceRequired: 200, waived: false, payments: [{ status: "PAID", amount: 200 }] };
  assert.equal(derivePayment({ ...p, refunded: 50 }).status, "PARTIALLY_REFUNDED");
  assert.equal(derivePayment({ ...p, refunded: 200 }).status, "REFUNDED");
  assert.deepEqual([derivePayment({ ...p, refunded: 900 }).refunded, derivePayment({ ...p, refunded: 900 }).status], [200, "REFUNDED"]);
  assert.equal(derivePayment({ ...p, payments: [], refunded: 500 }).status, "UNPAID");
});

// ---- gate definition -----------------------------------------------------------------------------------------------------------------------------
test("dispatch gate: outstanding advance blocks; a verified advance or a recorded waiver releases it; a required review blocks until recorded", () => {
  const o = { advanceRequired: 200, advancePaid: 0, advanceWaivedById: null, trustReviewRequired: false, trustReviewedAt: null as Date | null };
  assert.match(dispatchBlockedReason(o)!, /advance/);
  assert.equal(dispatchBlockedReason({ ...o, advancePaid: 200 }), null);
  assert.match(dispatchBlockedReason({ ...o, advancePaid: 199.99 })!, /advance/);                  // partial is not enough
  assert.equal(dispatchBlockedReason({ ...o, advanceWaivedById: "a1" }), null);
  assert.match(dispatchBlockedReason({ ...o, advancePaid: 200, trustReviewRequired: true })!, /review/);
  assert.equal(dispatchBlockedReason({ ...o, advancePaid: 200, trustReviewRequired: true, trustReviewedAt: new Date() }), null);
  assert.equal(dispatchBlockedReason({ ...o, advanceRequired: 0 }), null);
});

// ---- the browser cannot supply policy -----------------------------------------------------------------------------------------------------------
test("checkout input cannot carry an advance amount, a score, a waiver or a review decision: unknown fields are dropped", async (t) => {
  // The project's schema needs zod 4 (`z.email`). This sandbox only has zod 3, so the runtime half is skipped here and runs on a real install.
  const mod = await import("@/lib/validations/checkout").catch(() => null);
  if (!mod) return t.skip("zod 4 (the project's version) is not installed in this sandbox");
  const input = {
    email: "a@b.co", phone: "01711000000", billingSameAsShipping: true, paymentMethod: "COD", deliveryZone: "OUTSIDE_DHAKA",
    shippingAddress: { fullName: "Jo Doe", phone: "01711000000", line1: "House 1", city: "Sylhet", country: "Bangladesh" },
    advanceMethod: "BKASH", advanceReference: "TX12345678",
    advanceRequired: 0, advancePaid: 9999, advanceAmount: 0, trustScore: 100, trustSnapshot: { score: 100 }, trustReviewRequired: false, advanceWaivedById: "me", paymentStatus: "PAID",
  };
  const parsed = mod.checkoutSchema.safeParse(input);
  assert.ok(parsed.success);
  for (const k of ["advanceRequired", "advancePaid", "advanceAmount", "trustScore", "trustSnapshot", "trustReviewRequired", "advanceWaivedById", "paymentStatus"]) assert.ok(!(k in (parsed.data as object)), k);
});

test("source guard: no checkout input field, server action or placeOrder parameter can carry an advance amount, score or waiver", () => {
  const schema = readFileSync("src/lib/validations/checkout.ts", "utf8");
  const action = readFileSync("src/server/actions/checkout.actions.ts", "utf8");
  const placeOrderInput = readFileSync("src/server/services/order.service.ts", "utf8").match(/export type PlaceOrderInput = \{[\s\S]*?\n\};/)?.[0] ?? "";
  assert.ok(placeOrderInput.length > 50, "PlaceOrderInput not found");
  for (const forbidden of ["advanceRequired", "advancePaid", "advanceAmount", "trustScore", "trustSnapshot", "trustReview", "advanceWaived", "paymentStatus"]) {
    assert.ok(!schema.includes(forbidden), `checkout schema mentions ${forbidden}`);
    assert.ok(!placeOrderInput.includes(forbidden), `PlaceOrderInput mentions ${forbidden}`);
    assert.ok(!new RegExp(`${forbidden}\\s*:\\s*parsed`).test(action), `submitCheckout forwards ${forbidden}`);
  }
});

// ---- fraud-check helpers: duplicates, conflicts, malformed answers ---------------------------------------------------------------------
// A stand-in mapping used ONLY by these tests. Real mappings must come from a provider's official documentation.
const stand = (s: string): ParcelBucket | null => (s === "D" ? "delivered" : s === "C" ? "cancelled" : s === "R" ? "returned" : s === "T" ? "other" : null);

test("duplicate parcel records are counted once; in-transit parcels are not scored; returned parcels are kept separate", () => {
  const h = aggregateParcels([{ id: "1", status: "D" }, { id: "1", status: "D" }, { id: " 1 ", status: "D" }, { id: "2", status: "C" }, { id: "3", status: "R" }, { id: "4", status: "T" }], stand);
  assert.deepEqual(h, { delivered: 1, cancelled: 1, returned: 1, total: 4 });   // total counts every distinct parcel, including the one in transit
});

test("conflicting duplicates, unknown statuses and id-less records make the whole answer unusable instead of guessing", () => {
  assert.throws(() => aggregateParcels([{ id: "1", status: "D" }, { id: "1", status: "C" }], stand));
  assert.throws(() => aggregateParcels([{ id: "1", status: "???" }], stand));
  assert.throws(() => aggregateParcels([{ id: "", status: "D" }], stand));
});

test("malformed or incomplete provider answers are rejected, never turned into positive trust", () => {
  assert.equal(isValidFraudHistory({ delivered: 2, cancelled: 0 }), true);
  assert.equal(isValidFraudHistory({ delivered: 2, cancelled: 0, returned: 1 }), true);
  assert.equal(isValidFraudHistory({ delivered: 2, cancelled: 0, returned: 1, total: 3 }), true);
  assert.equal(isValidFraudHistory({ delivered: 2, cancelled: 0, returned: 1, total: 2 }), false);   // total smaller than its parts
  for (const bad of [null, undefined, 5, "x", {}, { delivered: 2 }, { cancelled: 1 }, { delivered: "2", cancelled: 0 }, { delivered: -1, cancelled: 0 }, { delivered: 1.5, cancelled: 0 }, { delivered: 2, cancelled: 0, returned: -1 }, { delivered: Number.POSITIVE_INFINITY, cancelled: 0 }]) {
    assert.equal(isValidFraudHistory(bad), false, JSON.stringify(bad));
  }
});

test("the same provider result always gives the same score", () => {
  const h = { delivered: 4, cancelled: 1, returned: 2 };
  const first = computeTrust(h, { phoneVerified: true });
  for (let i = 0; i < 5; i++) assert.deepEqual(computeTrust({ ...h }, { phoneVerified: true }), first);
});
