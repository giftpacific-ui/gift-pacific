import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, decideAdvance, evidencePolicyOf, paymentStatusFor, remainingBalance, sanitizePolicy, tierForRate, validateAdvancePolicy, type AdvancePolicy } from "../../src/lib/advance-policy";
import { assessTrust, DEFAULT_EVIDENCE_POLICY, validateEvidencePolicy, type EvidencePolicy } from "../../src/lib/courier-intelligence/trust";
import { combineReports } from "../../src/lib/courier-intelligence/combine";
import { EMPTY_METRICS, type ProviderReport } from "../../src/lib/courier-intelligence/types";

const policy: AdvancePolicy = { enabled: true, zones: ["OUTSIDE_DHAKA"], standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100 };
const adv = (rate: number | null, over: Partial<AdvancePolicy> = {}, zone = "OUTSIDE_DHAKA", total = 1500, rewardAllowed = true) =>
  decideAdvance({ ...policy, ...over }, { zone, orderTotal: total, rate, rewardAllowed });

test("boundaries 0/59/60/79/80/99/100 (percent) map to the configured tiers when positive evidence may count", () => {
  assert.deepEqual([0, 59].map((s) => [adv(s).tier, adv(s).required, adv(s).needsReview]), [["low", 200, true], ["low", 200, true]]);
  assert.deepEqual([60, 79].map((s) => [adv(s).tier, adv(s).required, adv(s).needsReview]), [["standard", 200, false], ["standard", 200, false]]);
  assert.deepEqual([80, 99].map((s) => [adv(s).tier, adv(s).required]), [["reduced", 100], ["reduced", 100]]);
  assert.deepEqual([adv(100).tier, adv(100).required], ["full", 100]); // zero is NOT waived unless explicitly enabled
  assert.deepEqual([adv(100, { zeroAtFullTrust: true }).tier, adv(100, { zeroAtFullTrust: true }).required], ["full", 0]);
});

test("a good record NEVER lowers the advance when positive evidence may not count (the default)", () => {
  for (const rate of [60, 79, 80, 99, 100]) {
    const d = adv(rate, {}, "OUTSIDE_DHAKA", 1500, false);
    assert.deepEqual([d.tier, d.required, d.needsReview], ["standard", 200, false], String(rate));
  }
  // ...but a poor record always counts
  assert.deepEqual([adv(40, {}, "OUTSIDE_DHAKA", 1500, false).tier, adv(40, {}, "OUTSIDE_DHAKA", 1500, false).needsReview], ["low", true]);
});

test("no reliable evidence = UNRATED: the standard advance and a review, never a made-up score and never a reduction", () => {
  const d = adv(null);
  assert.deepEqual([d.tier, d.required, d.needsReview], ["unrated", 200, true]);
  assert.match(d.explanation, /unrated/i);
  assert.deepEqual([adv(null, { reviewEnabled: false }).required, adv(null, { reviewEnabled: false }).needsReview], [200, false]);
  assert.equal(adv(null, {}, "OUTSIDE_DHAKA", 1500, true).required, 200); // even if rewards are allowed, there is nothing to reward
  assert.equal(tierForRate(policy, Number.NaN, true), "unrated");
});

test("disabled policy, other zones, and totals below the advance", () => {
  assert.equal(adv(0, { enabled: false }).required, 0);
  assert.equal(adv(0, {}, "DHAKA_CITY").required, 0);
  assert.equal(adv(0, {}, "OUTSIDE_DHAKA", 150).required, 150); // the advance is part of the total, never more than it
});

test("thresholds, amounts and evidence rules are configurable and validated", () => {
  assert.equal(validateAdvancePolicy(policy), null);
  for (const bad of [{ lowBelow: 90 }, { reducedFrom: 101, fullAt: 101 }, { reducedAmount: 300 }, { standardAmount: -1 }, { zones: [] as string[] }, { lowBelow: 70, reducedFrom: 70, fullAt: 70 }, { lowBelow: 59.5 },
    { minSample: 0 }, { minSample: 101 }, { minSample: 2.5 }, { minProviders: 0 }, { minProviders: 4 }, { maxAgeSeconds: 59 }, { maxAgeSeconds: 86_401 }]) {
    assert.ok(validateAdvancePolicy({ ...policy, ...bad }), JSON.stringify(bad));
  }
  assert.equal(adv(65, { lowBelow: 70, reducedFrom: 90, standardAmount: 250 }).required, 250); // 65 < 70 -> low tier
});

test("defaults are conservative: no reduction unless explicitly enabled, no credit for an unverified phone, a real minimum sample", () => {
  assert.deepEqual(
    [DEFAULT_POLICY.rewardEnabled, DEFAULT_POLICY.creditUnverifiedPhone, DEFAULT_POLICY.minSample, DEFAULT_POLICY.minProviders],
    [false, false, 5, 1],
  );
  assert.deepEqual(DEFAULT_EVIDENCE_POLICY, { minSample: 5, minProviders: 1, maxAgeSeconds: 3600, rewardEnabled: false, creditUnverifiedPhone: false });
  // an older stored policy without the new fields behaves like the defaults
  assert.deepEqual(evidencePolicyOf(policy), DEFAULT_EVIDENCE_POLICY);
  // an invalid stored policy never silently becomes lenient
  const s = sanitizePolicy({ ...policy, rewardEnabled: true, creditUnverifiedPhone: true, minSample: 0 });
  assert.ok(s.problem);
  assert.deepEqual([s.policy.rewardEnabled, s.policy.creditUnverifiedPhone, s.policy.minSample], [false, false, 5]);
});

test("tierForRate agrees with decideAdvance for every rate 0-100, non-default thresholds and both reward settings", () => {
  for (const over of [{}, { lowBelow: 70, reducedFrom: 90, fullAt: 100 }, { lowBelow: 30, reducedFrom: 50, fullAt: 95 }]) {
    for (const reward of [true, false]) {
      for (let n = 0; n <= 100; n++) assert.equal(tierForRate({ ...policy, ...over }, n, reward), adv(n, over, "OUTSIDE_DHAKA", 1500, reward).tier, `rate ${n} reward ${reward} ${JSON.stringify(over)}`);
    }
  }
});

test("balances and payment status never call a partial advance 'paid'", () => {
  assert.equal(remainingBalance(1500, 200), 1300);
  assert.equal(remainingBalance(100, 200), 0);
  assert.deepEqual([paymentStatusFor(1500, 0), paymentStatusFor(1500, 200), paymentStatusFor(1500, 1500)], ["UNPAID", "PARTIALLY_PAID", "PAID"]);
});

// ---- assessTrust: evidence -> rate ------------------------------------------------------------------------------------------------------------------
const rep = (provider: ProviderReport["provider"], over: Partial<ProviderReport> = {}): ProviderReport => ({
  provider, status: "ok", reason: null, checkedAt: "2026-11-21T10:00:00.000Z", cached: false, ...EMPTY_METRICS, delivered: 0, cancelled: 0, total: 0, ...over,
});
const P: EvidencePolicy = { ...DEFAULT_EVIDENCE_POLICY, rewardEnabled: true };
const assess = (reports: ProviderReport[], over: Partial<EvidencePolicy> = {}, phoneVerified = true, extra: { oldestAgeSeconds?: number; invalidPhone?: boolean } = {}) =>
  assessTrust({ combined: combineReports(reports), phoneVerified, policy: { ...P, ...over }, ...extra });

test("assessTrust: a rate is used only with enough parcels; 1 delivered of 1 is 100% but NOT reliable", () => {
  const tiny = assess([rep("steadfast", { delivered: 1, cancelled: 0, total: 1 })]);
  assert.deepEqual([tiny.state, tiny.rate, tiny.observedRate, tiny.rewardAllowed, tiny.insufficientEvidence], ["insufficient", null, 100, false, true]);
  assert.match(tiny.reasons.join(" "), /at least 5/);
  const enough = assess([rep("steadfast", { delivered: 9, cancelled: 1, total: 10 })]);
  assert.deepEqual([enough.state, enough.rate, enough.sample, enough.rewardAllowed], ["rated", 90, 10, true]);
  assert.equal(assess([rep("steadfast", { delivered: 4, cancelled: 1, total: 5 })]).rate, 80);
  assert.equal(assess([rep("steadfast", { delivered: 4, cancelled: 0, total: 4 })], { minSample: 4 }).state, "rated");
});

test("assessTrust: unavailable / no history / invalid phone / percentage-only never produce a rate or a default score", () => {
  const cases: [string, ReturnType<typeof assess>][] = [
    ["unavailable", assess([rep("steadfast", { status: "unavailable", reason: "timeout", delivered: null, cancelled: null, total: null })])],
    ["not configured", assess([rep("steadfast", { status: "not_configured", delivered: null, cancelled: null, total: null })])],
    ["no history", assess([rep("steadfast", { status: "no_history" })])],
    ["percentage only", assess([rep("steadfast", { delivered: null, cancelled: null, total: null, reportedDeliveryRate: 90 })])],
    ["invalid phone", assess([], {}, true, { invalidPhone: true })],
  ];
  for (const [name, a] of cases) {
    assert.equal(a.rate, null, name);
    assert.equal(a.rewardAllowed, false, name);
    assert.equal(a.insufficientEvidence, true, name);
  }
  assert.deepEqual(cases.map(([, a]) => a.state), ["unavailable", "unavailable", "no_history", "insufficient", "invalid_phone"]);
  assert.equal(assessTrust({ combined: null, phoneVerified: true, policy: P }).state, "unavailable");
});

test("assessTrust: courier coverage and freshness are enforced", () => {
  const one = [rep("steadfast", { delivered: 20, cancelled: 0, total: 20 })];
  assert.equal(assess(one, { minProviders: 2 }).state, "insufficient"); // only one courier contributed
  assert.equal(assess(one, { maxAgeSeconds: 3600 }, true, { oldestAgeSeconds: 3601 }).state, "insufficient");
  assert.equal(assess(one, { maxAgeSeconds: 3600 }, true, { oldestAgeSeconds: 3600 }).state, "rated");
  assert.match(assess(one, { maxAgeSeconds: 3600 }, true, { oldestAgeSeconds: 99999 }).reasons.join(" "), /older than/);
});

test("assessTrust: positive evidence may lower the advance ONLY if the switch is on AND the phone is verified or explicitly accepted", () => {
  const good = [rep("steadfast", { delivered: 30, cancelled: 0, total: 30 })];
  const matrix: [Partial<EvidencePolicy>, boolean, boolean][] = [
    [{ rewardEnabled: false }, true, false],                                  // switch off
    [{ rewardEnabled: true }, false, false],                                  // unverified phone, not accepted
    [{ rewardEnabled: true, creditUnverifiedPhone: true }, false, true],      // explicitly accepted
    [{ rewardEnabled: true }, true, true],                                    // verified
    [{ rewardEnabled: false, creditUnverifiedPhone: true }, true, false],     // acceptance alone does nothing
  ];
  for (const [over, verified, expected] of matrix) assert.equal(assess(good, over, verified).rewardAllowed, expected, JSON.stringify([over, verified]));
  // a POOR record is used regardless of any of these switches (negative evidence always counts)
  const poor = assess([rep("steadfast", { delivered: 2, cancelled: 8, total: 10 })], { rewardEnabled: false }, false);
  assert.deepEqual([poor.state, poor.rate], ["rated", 20]);
});

test("end to end (pure): the same courier evidence gives the standard advance by default and a reduced one only when explicitly enabled", () => {
  const good = [rep("steadfast", { delivered: 30, cancelled: 0, total: 30 })];
  const off = assess(good, { rewardEnabled: false }, true);
  assert.equal(decideAdvance(policy, { zone: "OUTSIDE_DHAKA", orderTotal: 1500, rate: off.rate, rewardAllowed: off.rewardAllowed }).required, 200);
  const on = assess(good, { rewardEnabled: true }, true);
  assert.equal(decideAdvance(policy, { zone: "OUTSIDE_DHAKA", orderTotal: 1500, rate: on.rate, rewardAllowed: on.rewardAllowed }).required, 100);
  const outage = assess([rep("steadfast", { status: "unavailable", reason: "error", delivered: null, cancelled: null, total: null })], { rewardEnabled: true }, true);
  assert.equal(decideAdvance(policy, { zone: "OUTSIDE_DHAKA", orderTotal: 1500, rate: outage.rate, rewardAllowed: outage.rewardAllowed }).required, 200); // an outage never lowers it
});

test("evidence policy validation", () => {
  assert.equal(validateEvidencePolicy(DEFAULT_EVIDENCE_POLICY), null);
  assert.ok(validateEvidencePolicy({ ...DEFAULT_EVIDENCE_POLICY, minSample: 0 }));
  assert.ok(validateEvidencePolicy({ ...DEFAULT_EVIDENCE_POLICY, minProviders: 5 }));
  assert.ok(validateEvidencePolicy({ ...DEFAULT_EVIDENCE_POLICY, maxAgeSeconds: 10 }));
});
