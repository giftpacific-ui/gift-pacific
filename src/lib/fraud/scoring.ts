import {
  LEVEL_RANK, SIGNAL_LABELS, levelForScore, reviewRequiredFor,
  type CreditSignal, type FlatRiskSignal, type FraudPolicy, type RiskLevel, type ScaledSignal, type SignalCode,
} from "@/lib/fraud/policy";

/**
 * Pure, deterministic fraud-risk scoring. It receives EVIDENCE (counts and flags already read from real records by
 * server/services/fraud-evidence.service.ts) and a policy, and returns the score with a complete explanation. No database, no clock, no
 * randomness: the same evidence and policy always give the same result, which is what makes a score auditable and testable.
 *
 * Invariants (each has a test): every point in the score appears in `signals` or `adjustments`; the listed contributions reconcile exactly with
 * `rawTotal`; the score is clamped to 0-100; a BLOCK match can never be offset by an allow-list or other credit; credits can never take away more
 * than `policy.maxCredit` in total; no signal exists without evidence for it.
 */
export type RelatedRefs = string[];

export type RiskEvidence = {
  history: {
    cancelled: number; failedDelivery: number; fraudRejected: number; delivered: number;
    refs: { cancelled: RelatedRefs; failedDelivery: RelatedRefs; fraudRejected: RelatedRefs };
  };
  advance: { rejected: number; verified: number };
  burst: { count: number; refs: RelatedRefs };
  duplicate: { count: number; refs: RelatedRefs };
  address: { distinctOtherPhones: number; knownDeliveredAddress: boolean };
  email: { distinctOtherPhones: number };
  /** null = no IP was available for this order (nothing is inferred). */
  ip: { distinctPhones: number } | null;
  lists: { blocked: { phone: boolean; email: boolean; ip: boolean }; allowed: { phone: boolean; email: boolean; ip: boolean } };
  /** The EXISTING trust result stored with the order at checkout (read, never recomputed). */
  trust: { score: number | null; insufficientEvidence: boolean; lowBelow: number | null; zoneConflict: boolean };
  order: { total: number };
  addressQuality: string[];
};

export type RiskSignal = { code: SignalCode; label: string; points: number; detail: string; refs?: string[] };
export type RiskAdjustment = { code: "BLOCK_FLOOR"; detail: string; from: number; to: number };
export type RiskResult = {
  score: number;
  level: RiskLevel;
  /** Sum of every listed signal point before adjustments and clamping. */
  rawTotal: number;
  signals: RiskSignal[];
  adjustments: RiskAdjustment[];
  reviewRequired: boolean;
};

export const emptyEvidence = (): RiskEvidence => ({
  history: { cancelled: 0, failedDelivery: 0, fraudRejected: 0, delivered: 0, refs: { cancelled: [], failedDelivery: [], fraudRejected: [] } },
  advance: { rejected: 0, verified: 0 },
  burst: { count: 0, refs: [] },
  duplicate: { count: 0, refs: [] },
  address: { distinctOtherPhones: 0, knownDeliveredAddress: false },
  email: { distinctOtherPhones: 0 },
  ip: null,
  lists: { blocked: { phone: false, email: false, ip: false }, allowed: { phone: false, email: false, ip: false } },
  trust: { score: null, insufficientEvidence: true, lowBelow: null, zoneConflict: false },
  order: { total: 0 },
  addressQuality: [],
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function scoreOrderRisk(e: RiskEvidence, policy: FraudPolicy): RiskResult {
  const signals: RiskSignal[] = [];
  const add = (code: SignalCode, points: number, detail: string, refs?: string[]) => {
    if (points === 0) return;
    signals.push({ code, label: SIGNAL_LABELS[code], points, detail, ...(refs && refs.length ? { refs: refs.slice(0, 5) } : {}) });
  };
  const scaled = (code: ScaledSignal, n: number, detail: (pts: number, cfg: { perUnit: number; cap: number }) => string, refs?: string[]) => {
    if (n <= 0) return;
    const cfg = policy.scaled[code];
    const pts = Math.min(n * cfg.perUnit, cfg.cap);
    add(code, pts, detail(pts, cfg), refs);
  };
  const flat = (code: FlatRiskSignal | CreditSignal, when: boolean, detail: string, refs?: string[]) => {
    if (when) add(code, policy.flat[code], detail, refs);
  };

  // ---- blocks first: an explicit admin decision
  const blocked = e.lists.blocked;
  flat("BLOCKED_PHONE", blocked.phone, "This phone number is on the admin block list.");
  flat("BLOCKED_EMAIL", blocked.email, "This e-mail address is on the admin block list.");
  flat("BLOCKED_IP", blocked.ip, "This network address is on the admin block list. Network addresses are shared by many people, so this alone is held for review, never rejected.");
  const anyBlock = blocked.phone || blocked.email || blocked.ip;

  // ---- history of the same customer (matched by normalised phone / e-mail / account)
  scaled("PRIOR_CANCELLED", e.history.cancelled, (pts, c) => `${plural(e.history.cancelled, "earlier order")} cancelled (${c.perUnit} each, max ${c.cap}). The system does not record who cancelled, so this includes staff and out-of-stock cancellations.`, e.history.refs.cancelled);
  scaled("PRIOR_FAILED_DELIVERY", e.history.failedDelivery, (pts, c) => `${plural(e.history.failedDelivery, "earlier order")} reached a failed delivery (${c.perUnit} each, max ${c.cap}).`, e.history.refs.failedDelivery);
  scaled("PRIOR_FRAUD_REJECTED", e.history.fraudRejected, (pts, c) => `${plural(e.history.fraudRejected, "earlier order")} rejected by an admin in fraud review (${c.perUnit} each, max ${c.cap}).`, e.history.refs.fraudRejected);
  scaled("ADVANCE_REJECTED", e.advance.rejected, (pts, c) => `${plural(e.advance.rejected, "earlier advance payment")} could not be verified and was rejected by staff (${c.perUnit} each, max ${c.cap}).`);

  // ---- frequency / duplicates
  const extra = Math.max(e.burst.count - policy.counts.burstFree, 0);
  scaled("PHONE_BURST", extra, (pts, c) => `${plural(e.burst.count, "other order")} from this phone in the last ${policy.windows.burstHours}h; the first ${policy.counts.burstFree} ${policy.counts.burstFree === 1 ? "is" : "are"} free, each further one adds ${c.perUnit} (max ${c.cap}).`, e.burst.refs);
  scaled("DUPLICATE_CART", e.duplicate.count, (pts, c) => `${plural(e.duplicate.count, "identical order")} (same items and quantities) placed by this customer in the last ${policy.windows.duplicateMinutes} minutes (${c.perUnit} each, max ${c.cap}).`, e.duplicate.refs);

  // ---- linked identities
  flat("ADDRESS_MANY_IDENTITIES", e.address.distinctOtherPhones >= policy.counts.addressPhones, `${plural(e.address.distinctOtherPhones, "other phone number")} used this same address in the last ${policy.windows.addressDays} days. Households, offices and gift orders also do this, so it is a weak signal.`);
  flat("EMAIL_MANY_PHONES", e.email.distinctOtherPhones >= policy.counts.emailPhones, `This e-mail was used with ${plural(e.email.distinctOtherPhones, "other phone number")} in the last ${policy.windows.emailDays} days.`);
  flat("IP_MANY_IDENTITIES", e.ip !== null && e.ip.distinctPhones >= policy.counts.ipPhones, `${plural(e.ip?.distinctPhones ?? 0, "different phone number")} ordered from this network address in the last ${policy.windows.ipHours}h. Shared networks (mobile carriers, offices, Wi-Fi) are common, so this is a weak signal and is not treated as one customer.`);

  // ---- content of this order
  flat("ADDRESS_QUALITY", e.addressQuality.length > 0, e.addressQuality.join("; ") + ".");
  flat("HIGH_VALUE_FIRST_ORDER", e.history.delivered === 0 && e.order.total >= policy.highValueAmount, `Order total ${Math.round(e.order.total)} is at or above ${policy.highValueAmount} and this customer has no delivered order on record.`);

  // ---- existing trust / zone checks (consumed as stored, never recomputed)
  flat("ZONE_MISMATCH", e.trust.zoneConflict, "The delivery zone chosen at checkout contradicted the address text (flagged by the existing zone check).");
  const lowTrust = e.trust.score !== null && !e.trust.insufficientEvidence && e.trust.lowBelow !== null && e.trust.score < e.trust.lowBelow;
  flat("LOW_TRUST_EVIDENCE", lowTrust, `The existing courier fraud-check trust score is ${e.trust.score}/100, below the low-trust line of ${e.trust.lowBelow}. (A missing or unavailable fraud check is not counted here.)`);

  // ---- credits: never when a block matched, and never more than maxCredit in total
  if (!anyBlock) {
    flat("ALLOW_PHONE", e.lists.allowed.phone, "This phone number is on the admin allow list (it lowers the score only; it never skips advance verification, low-trust review or the block list).");
    flat("ALLOW_EMAIL", e.lists.allowed.email, "This e-mail address is on the admin allow list (lowers the score only).");
    flat("ALLOW_IP", e.lists.allowed.ip, "This network address is on the admin allow list (lowers the score only; shared addresses make this a weak credit).");
    flat("DELIVERED_KNOWN_ADDRESS", e.address.knownDeliveredAddress, "An earlier order from this same phone to this same address was delivered.");
    flat("VERIFIED_ADVANCE_HISTORY", e.advance.verified > 0, `${plural(e.advance.verified, "earlier advance payment")} for this customer was verified by staff.`);
    const credits = signals.filter((s) => s.points < 0).reduce((n, s) => n + s.points, 0);
    if (credits < -policy.maxCredit) add("CREDIT_CAP", -policy.maxCredit - credits, `Credits add up to ${-credits}, limited to ${policy.maxCredit}.`);
  }

  const rawTotal = signals.reduce((n, s) => n + s.points, 0);
  let score = Math.max(0, Math.min(100, Math.round(rawTotal)));

  // ---- floors: an explicit block always reaches at least its level, whatever the configured weights
  const adjustments: RiskAdjustment[] = [];
  const floorTo = blocked.phone || blocked.email ? policy.thresholds.critical : blocked.ip ? policy.thresholds.high : null;
  if (floorTo !== null && score < floorTo) {
    adjustments.push({ code: "BLOCK_FLOOR", detail: `A block-list match always scores at least ${floorTo}.`, from: score, to: floorTo });
    score = floorTo;
  }

  const level = levelForScore(score, policy.thresholds);
  return { score, level, rawTotal, signals, adjustments, reviewRequired: reviewRequiredFor(level, policy) };
}

/** The reasons an address/name looks like a placeholder, from the text alone (Unicode-aware: Bangla addresses are judged the same way). */
export function addressSuspicion(a: { fullName?: string | null; line1?: string | null; line2?: string | null }): string[] {
  const out: string[] = [];
  const line = `${a.line1 ?? ""}`.trim();
  const name = `${a.fullName ?? ""}`.trim();
  const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
  const alnum = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (alnum(line) < 6) out.push("the address line is very short");
  else if (letters(line) === 0) out.push("the address line contains no letters");
  if (/(.)\1{4,}/u.test(line) || /(.)\1{4,}/u.test(name)) out.push("the address or name contains a long run of the same character");
  const tokens = `${line} ${name}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const PLACEHOLDERS = ["test", "asdf", "qwerty", "xxx", "abc", "fake", "dummy", "none", "n/a"];
  if (tokens.some((t) => PLACEHOLDERS.includes(t)) || /^(?:na|123|1234|12345)$/.test(line.toLowerCase())) out.push("it contains a placeholder word");
  if (letters(name) < 3) out.push("the name looks incomplete");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The confirmation gate (pure). Used by dispatchBlockedReason in advance.service.ts, AFTER the advance and low-trust checks.
// ---------------------------------------------------------------------------------------------------------------------------------
export type RiskGateOrder = {
  riskReviewRequired: boolean;
  riskLevel: RiskLevel | null;
  riskReviewDecision: "APPROVED" | "REJECTED" | null;
  riskReviewedLevel: RiskLevel | null;
};

/**
 * Why the fraud review blocks this order (null = it does not). A review covers the level the reviewer saw AND anything below it: if the risk later
 * ESCALATES past what was reviewed, the order is blocked again. A rejection never clears the gate (the order is cancelled instead).
 */
export function riskGateBlockedReason(o: RiskGateOrder): string | null {
  if (!o.riskReviewRequired) return null;
  const level = o.riskLevel ?? "HIGH";
  if (o.riskReviewDecision === "APPROVED" && o.riskReviewedLevel && LEVEL_RANK[o.riskReviewedLevel] >= LEVEL_RANK[level]) return null;
  return level === "CRITICAL"
    ? "This order is on hold for fraud review (critical risk). An authorised admin must review it and record a reason before it can be confirmed or dispatched."
    : "This order needs a fraud-risk review (high risk). An admin must review it and record a reason before it can be confirmed or dispatched.";
}
