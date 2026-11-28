import { test } from "node:test";
import assert from "node:assert/strict";
import { addressKeyOf, normalizeBdPhone, normalizeEmailForRisk, normalizeIdentifier, normalizeIp } from "@/lib/fraud/identity";
import { DEFAULT_FRAUD_POLICY, levelForScore, resolveFraudPolicy, reviewRequiredFor, validateFraudPolicy, type FraudPolicy } from "@/lib/fraud/policy";
import { addressSuspicion, emptyEvidence, riskGateBlockedReason, scoreOrderRisk, type RiskEvidence } from "@/lib/fraud/scoring";

const P = DEFAULT_FRAUD_POLICY;
const ev = (over: (e: RiskEvidence) => void): RiskEvidence => { const e = emptyEvidence(); over(e); return e; };
const policy = (over: (p: FraudPolicy) => void): FraudPolicy => { const p = structuredClone(P); over(p); return p; };
const codes = (e: RiskEvidence, p = P) => scoreOrderRisk(e, p).signals.map((s) => s.code);

// ---------------------------------------------------------------------------------------------------------------- normalisation
test("phone: every Bangladesh spelling normalises to the SAME 01XXXXXXXXX key (the existing normaliser is the only one)", () => {
  for (const raw of ["01711000000", "+8801711000000", "8801711000000", "008801711000000", "+880 1711-000 000", "(01711) 000.000", " 01711000000 "]) assert.equal(normalizeBdPhone(raw), "01711000000", raw);
  for (const bad of ["", null, undefined, "017110", "02711000000", "+9112345678901", "abc"]) assert.equal(normalizeBdPhone(bad as never), null, String(bad));
  assert.equal(normalizeIdentifier("PHONE", "+8801811000000"), "01811000000");
});

test("e-mail: case/space folded; Gmail dots and +tags removed; other providers are NOT altered (so two different people are never merged)", () => {
  assert.equal(normalizeEmailForRisk("  Jane.Doe+shop@Gmail.com "), "janedoe@gmail.com");
  assert.equal(normalizeEmailForRisk("j.a.n.e@googlemail.com"), "jane@gmail.com");
  assert.equal(normalizeEmailForRisk("Jane.Doe+shop@Example.com"), "jane.doe+shop@example.com");
  assert.equal(normalizeEmailForRisk("a.b@yahoo.com") !== normalizeEmailForRisk("ab@yahoo.com"), true);
  for (const bad of ["", "no-at", "a@b", "@x.com", "a@@x.com", "a b@x.com", "a@.com", null]) assert.equal(normalizeEmailForRisk(bad as never), null, String(bad));
});

test("IP: IPv4 as-is; IPv6 reduced to its /64 (privacy addresses rotate); IPv4-mapped becomes IPv4; garbage is rejected", () => {
  assert.equal(normalizeIp("203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp("2001:db8:abcd:12::1"), "2001:0db8:abcd:0012::/64");
  assert.equal(normalizeIp("2001:db8:abcd:12:aaaa:bbbb:cccc:dddd"), normalizeIp("2001:db8:abcd:12::99"));
  assert.notEqual(normalizeIp("2001:db8:abcd:13::1"), normalizeIp("2001:db8:abcd:12::1"));
  for (const bad of ["", "999.1.1.1", "not-an-ip", "1.2.3", null]) assert.equal(normalizeIp(bad as never), null, String(bad));
});

test("address key: punctuation/spacing/case insensitive, order of words kept; too little text gives no key; not reversible", () => {
  const a = addressKeyOf({ line1: "House 5, Road-2 ", city: "Dhaka" });
  assert.equal(a, addressKeyOf({ line1: "house 5 road 2", city: "DHAKA" }));
  assert.notEqual(a, addressKeyOf({ line1: "House 6, Road 2", city: "Dhaka" }));
  assert.equal(addressKeyOf({ line1: "x", city: "y" }), null);
  assert.match(a!, /^[0-9a-f]{32}$/);
  assert.ok(addressKeyOf({ line1: "বাড়ি ৫, রোড ২", city: "ঢাকা" }), "Bangla addresses get a key too");
});

// ---------------------------------------------------------------------------------------------------------------- scoring
test("no evidence -> score 0, LOW, no signals (a signal never exists without evidence)", () => {
  const r = scoreOrderRisk(emptyEvidence(), P);
  assert.deepEqual([r.score, r.level, r.signals.length, r.adjustments.length, r.reviewRequired], [0, "LOW", 0, 0, false]);
});

test("every signal reports its reason and exact contribution; the listed points reconcile exactly with the total", () => {
  const e = ev((x) => {
    x.history.cancelled = 2; x.history.refs.cancelled = ["GP-1", "GP-2"];
    x.history.failedDelivery = 1; x.history.refs.failedDelivery = ["GP-3"];
    x.burst.count = 3; x.burst.refs = ["GP-4", "GP-5", "GP-6"];
    x.duplicate.count = 1; x.duplicate.refs = ["GP-7"];
    x.addressQuality = ["the address line is very short"];
  });
  const r = scoreOrderRisk(e, P);
  const by = Object.fromEntries(r.signals.map((s) => [s.code, s]));
  assert.equal(by.PRIOR_CANCELLED.points, 16);       // 2 x 8
  assert.equal(by.PRIOR_FAILED_DELIVERY.points, 15); // 1 x 15
  assert.equal(by.PHONE_BURST.points, 12);           // (3 - 1 free) x 6
  assert.equal(by.DUPLICATE_CART.points, 15);
  assert.equal(by.ADDRESS_QUALITY.points, 10);
  assert.deepEqual(by.PRIOR_CANCELLED.refs, ["GP-1", "GP-2"]);
  for (const s of r.signals) { assert.ok(s.label.length > 3); assert.ok(s.detail.length > 10, s.code); }
  assert.equal(r.rawTotal, 16 + 15 + 12 + 15 + 10);
  assert.equal(r.signals.reduce((n, s) => n + s.points, 0), r.rawTotal, "breakdown reconciles");
  assert.equal(r.score, 68);
  assert.equal(r.level, "HIGH");
  assert.equal(r.reviewRequired, true);
  assert.match(by.PRIOR_CANCELLED.detail, /does not record who cancelled/);
});

test("caps apply per signal; the score is clamped to 0-100", () => {
  const e = ev((x) => { x.history.cancelled = 50; x.history.failedDelivery = 50; x.history.fraudRejected = 50; x.advance.rejected = 50; });
  const r = scoreOrderRisk(e, P);
  assert.equal(r.signals.find((s) => s.code === "PRIOR_CANCELLED")!.points, 24);
  assert.equal(r.signals.find((s) => s.code === "PRIOR_FAILED_DELIVERY")!.points, 45);
  assert.equal(r.rawTotal, 24 + 45 + 50 + 20);
  assert.equal(r.score, 100);
  assert.equal(r.level, "CRITICAL");
});

test("default levels: 0-29 LOW, 30-59 MEDIUM, 60-79 HIGH, 80-100 CRITICAL; thresholds are configurable and change the outcome", () => {
  for (const [s, l] of [[0, "LOW"], [29, "LOW"], [30, "MEDIUM"], [59, "MEDIUM"], [60, "HIGH"], [79, "HIGH"], [80, "CRITICAL"], [100, "CRITICAL"]] as const) assert.equal(levelForScore(s, P.thresholds), l, String(s));
  const e = ev((x) => { x.history.failedDelivery = 2; }); // 30 points
  assert.equal(scoreOrderRisk(e, P).level, "MEDIUM");
  assert.equal(scoreOrderRisk(e, policy((p) => { p.thresholds = { medium: 10, high: 25, critical: 50 }; })).level, "HIGH");
  assert.equal(scoreOrderRisk(e, policy((p) => { p.thresholds = { medium: 40, high: 70, critical: 90 }; })).level, "LOW");
});

test("weights are configurable: changing a weight changes the points and the explanation", () => {
  const e = ev((x) => { x.history.cancelled = 1; });
  assert.equal(scoreOrderRisk(e, P).score, 8);
  const r = scoreOrderRisk(e, policy((p) => { p.scaled.PRIOR_CANCELLED = { perUnit: 40, cap: 80 }; }));
  assert.equal(r.score, 40);
  assert.match(r.signals[0].detail, /40 each, max 80/);
  assert.equal(scoreOrderRisk(e, policy((p) => { p.scaled.PRIOR_CANCELLED = { perUnit: 0, cap: 0 }; })).signals.length, 0);
});

test("review is required only under ENFORCE and from the configured level; ADVISORY / OFF never gate", () => {
  assert.equal(reviewRequiredFor("MEDIUM", P), false);
  assert.equal(reviewRequiredFor("HIGH", P), true);
  assert.equal(reviewRequiredFor("HIGH", { mode: "ENFORCE", reviewFrom: "CRITICAL" }), false);
  assert.equal(reviewRequiredFor("CRITICAL", { mode: "ENFORCE", reviewFrom: "CRITICAL" }), true);
  for (const mode of ["ADVISORY", "OFF"] as const) assert.equal(reviewRequiredFor("CRITICAL", { mode, reviewFrom: "HIGH" }), false);
});

test("block list: a phone/e-mail block always reaches CRITICAL (even if its weight is set to 0), an IP block always reaches HIGH but never CRITICAL by itself", () => {
  const phone = ev((x) => { x.lists.blocked.phone = true; });
  assert.deepEqual([scoreOrderRisk(phone, P).score, scoreOrderRisk(phone, P).level], [100, "CRITICAL"]);
  const weak = policy((p) => { p.flat.BLOCKED_PHONE = 0; p.flat.BLOCKED_IP = 0; });
  const r = scoreOrderRisk(phone, weak);
  assert.equal(r.level, "CRITICAL");
  assert.equal(r.adjustments[0].code, "BLOCK_FLOOR");
  assert.equal(r.adjustments[0].to, 80);
  const ip = scoreOrderRisk(ev((x) => { x.lists.blocked.ip = true; }), P);
  assert.equal(ip.level, "HIGH");
  assert.equal(ip.score, 60);
  assert.equal(scoreOrderRisk(ev((x) => { x.lists.blocked.ip = true; }), weak).level, "HIGH");
});

test("allow list: lowers the score, but can NEVER offset a block, and credits are capped in total", () => {
  const base = ev((x) => { x.history.failedDelivery = 3; }); // 45
  const allowed = ev((x) => { x.history.failedDelivery = 3; x.lists.allowed.phone = true; });
  assert.equal(scoreOrderRisk(base, P).score, 45);
  assert.equal(scoreOrderRisk(allowed, P).score, 15);
  const both = ev((x) => { x.lists.blocked.phone = true; x.lists.allowed.phone = true; x.lists.allowed.email = true; });
  const r = scoreOrderRisk(both, P);
  assert.equal(r.level, "CRITICAL");
  assert.ok(!r.signals.some((s) => s.points < 0), "no credit is applied beside a block");
  // many credits together are capped at maxCredit (40)
  const lots = ev((x) => { x.history.failedDelivery = 4; x.history.cancelled = 3; x.lists.allowed.phone = true; x.lists.allowed.email = true; x.address.knownDeliveredAddress = true; x.advance.verified = 2; });
  const c = scoreOrderRisk(lots, P);
  const credits = c.signals.filter((s) => s.points < 0 || s.code === "CREDIT_CAP").reduce((n, s) => n + s.points, 0);
  assert.equal(credits, -40);
  assert.ok(c.signals.some((s) => s.code === "CREDIT_CAP"));
  assert.equal(c.signals.reduce((n, s) => n + s.points, 0), c.rawTotal);
});

test("shared IP is NOT assumed to be one customer: it needs many distinct phones, carries a weak weight and can never gate an order by itself", () => {
  assert.ok(!codes(ev((x) => { x.ip = { distinctPhones: 4 }; })).includes("IP_MANY_IDENTITIES"));
  const r = scoreOrderRisk(ev((x) => { x.ip = { distinctPhones: 40 }; }), P);
  assert.deepEqual(r.signals.map((s) => s.code), ["IP_MANY_IDENTITIES"]);
  assert.equal(r.score, 6);
  assert.equal(r.level, "LOW");
  assert.match(r.signals[0].detail, /weak signal/);
  assert.ok(!codes(emptyEvidence()).includes("IP_MANY_IDENTITIES"), "no IP available -> nothing inferred");
});

test("existing trust evidence is consumed only when it is real: missing/unavailable evidence is not penalised; zone conflict is carried over", () => {
  assert.ok(!codes(ev((x) => { x.trust = { score: 50, insufficientEvidence: true, lowBelow: 60, zoneConflict: false }; })).includes("LOW_TRUST_EVIDENCE"));
  assert.ok(codes(ev((x) => { x.trust = { score: 30, insufficientEvidence: false, lowBelow: 60, zoneConflict: false }; })).includes("LOW_TRUST_EVIDENCE"));
  assert.ok(!codes(ev((x) => { x.trust = { score: 75, insufficientEvidence: false, lowBelow: 60, zoneConflict: false }; })).includes("LOW_TRUST_EVIDENCE"));
  assert.ok(codes(ev((x) => { x.trust.zoneConflict = true; })).includes("ZONE_MISMATCH"));
});

test("linked-identity and high-value signals fire only at their thresholds", () => {
  assert.ok(!codes(ev((x) => { x.address.distinctOtherPhones = 2; })).includes("ADDRESS_MANY_IDENTITIES"));
  assert.ok(codes(ev((x) => { x.address.distinctOtherPhones = 3; })).includes("ADDRESS_MANY_IDENTITIES"));
  assert.ok(!codes(ev((x) => { x.email.distinctOtherPhones = 1; })).includes("EMAIL_MANY_PHONES"));
  assert.ok(codes(ev((x) => { x.email.distinctOtherPhones = 2; })).includes("EMAIL_MANY_PHONES"));
  assert.ok(codes(ev((x) => { x.order.total = 20000; })).includes("HIGH_VALUE_FIRST_ORDER"));
  assert.ok(!codes(ev((x) => { x.order.total = 20000; x.history.delivered = 1; })).includes("HIGH_VALUE_FIRST_ORDER"), "a customer with delivered history is not 'first order'");
  assert.ok(!codes(ev((x) => { x.order.total = 14999; })).includes("HIGH_VALUE_FIRST_ORDER"));
});

test("scoring is deterministic: same evidence and policy always give the identical result", () => {
  const e = ev((x) => { x.history.cancelled = 3; x.burst.count = 4; x.trust.zoneConflict = true; });
  assert.deepEqual(scoreOrderRisk(e, P), scoreOrderRisk(structuredClone(e), structuredClone(P)));
});

// ---------------------------------------------------------------------------------------------------------------- policy
test("policy validation rejects overlapping thresholds and out-of-range weights; invalid stored JSON never weakens protection (defaults apply)", () => {
  assert.equal(validateFraudPolicy(P), null);
  assert.match(validateFraudPolicy(policy((p) => { p.thresholds = { medium: 60, high: 60, critical: 80 }; }))!, /medium < high < critical/);
  assert.match(validateFraudPolicy(policy((p) => { p.thresholds = { medium: 30, high: 60, critical: 101 }; }))!, /between 1 and 100/);
  assert.match(validateFraudPolicy(policy((p) => { p.flat.ALLOW_PHONE = 5; }))!, /ALLOW_PHONE/);
  assert.match(validateFraudPolicy(policy((p) => { p.flat.BLOCKED_PHONE = -5; }))!, /BLOCKED_PHONE/);
  assert.match(validateFraudPolicy(policy((p) => { p.scaled.PHONE_BURST.cap = 1000; }))!, /PHONE_BURST/);
  assert.match(validateFraudPolicy(policy((p) => { p.ipRetentionDays = 0; }))!, /retention/i);
  const bad = resolveFraudPolicy({ thresholds: { medium: 90, high: 60, critical: 80 } });
  assert.deepEqual(bad.policy, P);
  assert.ok(bad.problem);
  assert.equal(resolveFraudPolicy(null).problem, null);
});

test("policy resolution merges a partial override over the defaults and ignores unknown keys", () => {
  const r = resolveFraudPolicy({ thresholds: { high: 70 }, mode: "ADVISORY", evil: { x: 1 }, scaled: { PRIOR_CANCELLED: { perUnit: 9 } } });
  assert.equal(r.problem, null);
  assert.deepEqual(r.policy.thresholds, { medium: 30, high: 70, critical: 80 });
  assert.equal(r.policy.mode, "ADVISORY");
  assert.deepEqual(r.policy.scaled.PRIOR_CANCELLED, { perUnit: 9, cap: 24 });
  assert.ok(!("evil" in r.policy));
});

// ---------------------------------------------------------------------------------------------------------------- address quality + gate
test("address suspicion: placeholders / junk are flagged from the text alone; real English and Bangla addresses are not", () => {
  assert.equal(addressSuspicion({ fullName: "Rahim Uddin", line1: "House 12, Road 5, Dhanmondi" }).length, 0);
  assert.equal(addressSuspicion({ fullName: "রহিম উদ্দিন", line1: "বাড়ি ১২, রোড ৫, ধানমন্ডি" }).length, 0);
  assert.ok(addressSuspicion({ fullName: "Rahim", line1: "abc" }).some((r) => /very short/.test(r)));
  assert.ok(addressSuspicion({ fullName: "Rahim", line1: "123456789012" }).some((r) => /no letters/.test(r)));
  assert.ok(addressSuspicion({ fullName: "aaaaaaa", line1: "House 5 Road 3 Uttara" }).some((r) => /same character/.test(r)));
  assert.ok(addressSuspicion({ fullName: "Test User", line1: "House 5 Road 3 Uttara" }).some((r) => /placeholder/.test(r)));
  assert.ok(addressSuspicion({ fullName: "A", line1: "House 5 Road 3 Uttara" }).some((r) => /name looks incomplete/.test(r)));
});

test("gate: not required -> open; required and unreviewed -> blocked; an approval covers its level and below, but escalation re-blocks; rejection never clears it", () => {
  const o = (over: Partial<Parameters<typeof riskGateBlockedReason>[0]>) => riskGateBlockedReason({ riskReviewRequired: true, riskLevel: "HIGH", riskReviewDecision: null, riskReviewedLevel: null, ...over });
  assert.equal(o({ riskReviewRequired: false }), null);
  assert.match(o({})!, /needs a fraud-risk review/);
  assert.match(o({ riskLevel: "CRITICAL" })!, /on hold for fraud review/);
  assert.equal(o({ riskReviewDecision: "APPROVED", riskReviewedLevel: "HIGH" }), null);
  assert.equal(o({ riskReviewDecision: "APPROVED", riskReviewedLevel: "CRITICAL" }), null, "approved at a higher level also covers a lower one");
  assert.match(o({ riskLevel: "CRITICAL", riskReviewDecision: "APPROVED", riskReviewedLevel: "HIGH" })!, /on hold/, "escalated beyond what was reviewed");
  assert.match(o({ riskReviewDecision: "REJECTED", riskReviewedLevel: "HIGH" })!, /fraud-risk review/);
  assert.match(o({ riskLevel: null })!, /needs a fraud-risk review/, "missing level fails closed");
});
