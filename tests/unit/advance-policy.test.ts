import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrust, decideAdvance, EMPTY_HISTORY, historyIsConsistent, tierForScore, totalParcels, trustFromOutcome, paymentStatusFor, remainingBalance, validateAdvancePolicy, type AdvancePolicy } from "../../src/lib/advance-policy";

const policy: AdvancePolicy = { enabled: true, zones: ["OUTSIDE_DHAKA"], standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100 };
const adv = (score: number, over: Partial<AdvancePolicy> = {}, zone = "OUTSIDE_DHAKA", total = 1500) => decideAdvance({ ...policy, ...over }, { zone, orderTotal: total, trustScore: score });

test("boundaries 0/59/60/79/80/99/100 map to the configured tiers", () => {
  assert.deepEqual([0, 59].map((s) => [adv(s).tier, adv(s).required, adv(s).needsReview]), [["low", 200, true], ["low", 200, true]]);
  assert.deepEqual([60, 79].map((s) => [adv(s).tier, adv(s).required, adv(s).needsReview]), [["standard", 200, false], ["standard", 200, false]]);
  assert.deepEqual([80, 99].map((s) => [adv(s).tier, adv(s).required]), [["reduced", 100], ["reduced", 100]]);
  assert.deepEqual([adv(100).tier, adv(100).required], ["full", 100]);                       // zero NOT waived unless explicitly enabled
  assert.deepEqual([adv(100, { zeroAtFullTrust: true }).tier, adv(100, { zeroAtFullTrust: true }).required], ["full", 0]);
});
test("disabled policy, other zones, and totals below the advance", () => {
  assert.equal(adv(0, { enabled: false }).required, 0);
  assert.equal(adv(0, {}, "DHAKA_CITY").required, 0);
  assert.equal(adv(0, {}, "OUTSIDE_DHAKA", 150).required, 150); // the advance is part of the total, never more than it
});
test("thresholds and amounts are configurable and validated", () => {
  assert.equal(validateAdvancePolicy(policy), null);
  for (const bad of [{ lowBelow: 90 }, { reducedFrom: 101, fullAt: 101 }, { reducedAmount: 300 }, { standardAmount: -1 }, { zones: [] as string[] }, { lowBelow: 70, reducedFrom: 70, fullAt: 70 }, { lowBelow: 59.5 }]) {
    assert.ok(validateAdvancePolicy({ ...policy, ...bad }), JSON.stringify(bad));
  }
  assert.equal(adv(65, { lowBelow: 70, reducedFrom: 90, standardAmount: 250 }).required, 250); // 65 < 70 -> low tier
});
test("trust formula with a VERIFIED phone: 50 + 10 x min(delivered,5) - 20 x cancelled, clamped 0-100", () => {
  const V = { phoneVerified: true };
  assert.deepEqual([computeTrust(null).score, computeTrust(EMPTY_HISTORY, V).insufficientEvidence], [50, true]);
  assert.equal(computeTrust({ delivered: 5, cancelled: 0 }, V).score, 100);
  assert.equal(computeTrust({ delivered: 8, cancelled: 0 }, V).score, 100);   // delivered credit stops at 5
  assert.equal(computeTrust({ delivered: 3, cancelled: 0 }, V).score, 80);
  assert.equal(computeTrust({ delivered: 3, cancelled: 1 }, V).score, 60);
  assert.equal(computeTrust({ delivered: 1, cancelled: 3 }, V).score, 0);     // clamped at 0
  assert.equal(computeTrust({ delivered: 0, cancelled: 9 }, V).score, 0);
  const r = computeTrust({ delivered: 2, cancelled: 1 }, V);
  assert.ok(r.reasons.length >= 3 && r.reasons.every((x) => typeof x === "string")); // explainable
});
test("trust with an UNVERIFIED phone (the only case today): delivered history earns nothing, cancelled history still lowers the score", () => {
  for (const opts of [undefined, {}, { phoneVerified: false }]) {
    assert.equal(computeTrust({ delivered: 8, cancelled: 0 }, opts).score, 50);
    assert.equal(computeTrust({ delivered: 5, cancelled: 1 }, opts).score, 30);
    assert.equal(computeTrust({ delivered: 0, cancelled: 2 }, opts).score, 10);
    assert.equal(computeTrust({ delivered: 0, cancelled: 9 }, opts).score, 0);
  }
  assert.match(computeTrust({ delivered: 8, cancelled: 0 }).reasons.join(" "), /not verified/);
});
test("returned parcels are shown but never scored (no documented provider mapping)", () => {
  for (const phoneVerified of [true, false]) {
    assert.equal(computeTrust({ delivered: 0, cancelled: 1, returned: 4 }, { phoneVerified }).score, 30);
    assert.equal(computeTrust({ delivered: 3, cancelled: 0, returned: 2 }, { phoneVerified }).score, phoneVerified ? 80 : 50);
  }
  const only = computeTrust({ delivered: 0, cancelled: 0, returned: 3 }, { phoneVerified: true });
  assert.deepEqual([only.score, only.insufficientEvidence], [50, true]);
  assert.match(only.reasons.join(" "), /returned.*not scored/);
});
test("trustFromOutcome keeps unavailable, no-history and ok distinct but never lifts trust on missing data", () => {
  for (const reason of ["no_provider", "invalid_phone", "timeout", "error", "invalid_response"] as const) {
    const t = trustFromOutcome({ status: "unavailable", reason }, { phoneVerified: true });
    assert.deepEqual([t.score, t.insufficientEvidence], [50, true]);
    assert.match(t.reasons.join(" "), /standard advance rule applies/);
  }
  const none = trustFromOutcome({ status: "no_history", provider: "x" }, { phoneVerified: true });
  assert.deepEqual([none.score, none.insufficientEvidence], [50, true]);
  assert.match(none.reasons.join(" "), /no delivered or cancelled/);
  assert.equal(trustFromOutcome({ status: "ok", provider: "x", history: { delivered: 4, cancelled: 1 } }, { phoneVerified: true }).score, 70);
  assert.equal(trustFromOutcome({ status: "ok", provider: "x", history: { delivered: 4, cancelled: 1 } }).score, 30);
});
test("trust thresholds map to the unchanged advance tiers (standard below 60 and 60-79, reduced 80-99, full at 100)", () => {
  assert.deepEqual([40, 59, 60, 79].map((n) => adv(n).required), [200, 200, 200, 200]);
  assert.equal(adv(80).required, 100);
  assert.equal(adv(99).required, 100);
  assert.equal(adv(100).required, 100);                       // zero only if explicitly enabled
  assert.equal(adv(100, { zeroAtFullTrust: true }).required, 0);
  assert.equal(adv(50).required, 200);                        // the default for every customer while no provider is configured
});
test("balances and payment status never call a partial advance 'paid'", () => {
  assert.equal(remainingBalance(1500, 200), 1300);
  assert.equal(remainingBalance(100, 200), 0);
  assert.deepEqual([paymentStatusFor(1500, 0), paymentStatusFor(1500, 200), paymentStatusFor(1500, 1500)], ["UNPAID", "PARTIALLY_PAID", "PAID"]);
});

test("tierForScore agrees with decideAdvance for every score 0-100 and for non-default thresholds", () => {
  for (const over of [{}, { lowBelow: 70, reducedFrom: 90, fullAt: 100 }, { lowBelow: 30, reducedFrom: 50, fullAt: 95 }]) {
    for (let n = 0; n <= 100; n++) assert.equal(tierForScore({ ...policy, ...over }, n), adv(n, over).tier, `score ${n} ${JSON.stringify(over)}`);
  }
  assert.equal(tierForScore(policy, Number.NaN), "low");   // a broken score is treated as the default 50 (below the low threshold of 60)
});

test("a reported total is display-only: it must not be smaller than its parts, and it never changes the score", () => {
  assert.equal(historyIsConsistent({ delivered: 3, cancelled: 1, returned: 1, total: 5 }), true);
  assert.equal(historyIsConsistent({ delivered: 3, cancelled: 1, returned: 1, total: 9 }), true);   // in-transit parcels may make the total larger
  assert.equal(historyIsConsistent({ delivered: 3, cancelled: 1, total: 3 }), false);
  assert.equal(historyIsConsistent({ delivered: 1, cancelled: 0, total: -1 }), false);
  const bad = computeTrust({ delivered: 5, cancelled: 0, total: 2 }, { phoneVerified: true });
  assert.deepEqual([bad.score, bad.insufficientEvidence], [50, true]);
  assert.match(bad.reasons.join(" "), /inconsistent/);
  assert.equal(computeTrust({ delivered: 3, cancelled: 1, total: 4 }, { phoneVerified: true }).score, computeTrust({ delivered: 3, cancelled: 1, total: 400 }, { phoneVerified: true }).score);
  assert.equal(totalParcels({ delivered: 3, cancelled: 1, returned: 2 }), 6);
  assert.equal(totalParcels({ delivered: 3, cancelled: 1, returned: 2, total: 9 }), 9);
  assert.equal(totalParcels({ delivered: 0, cancelled: 0 }), 0);
});

test("the two new fallback reasons are explained and keep the safe default", () => {
  for (const reason of ["disabled", "rate_limited"] as const) {
    const t = trustFromOutcome({ status: "unavailable", reason }, { phoneVerified: true });
    assert.deepEqual([t.score, t.insufficientEvidence], [50, true]);
    assert.match(t.reasons.join(" "), /standard advance rule applies/);
  }
});
