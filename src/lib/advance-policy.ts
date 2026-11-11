/**
 * Advance-payment + trust policy (pure, server-authoritative).
 *
 * The "trust score" means CONFIDENCE IN SUCCESSFUL FULFILMENT (100 = highest). Its ONLY evidence is the FRAUD CHECK: a courier-network parcel record
 * for the order's phone number, obtained server-side from a configured fraud-check provider. Our own website order history is NOT used.
 * It is a transparent rule-based heuristic, not a validated prediction and not a fraud verdict.
 *
 * Formula (verified phone):    50 + 10 x min(delivered, 5) - 20 x cancelled, clamped to 0-100.
 * Formula (UNVERIFIED phone):  50 - 20 x cancelled, clamped to 0-100  (delivered history earns NOTHING).
 * The phone is typed by the customer and the project has no verified-phone mechanism (no OTP): so only NEGATIVE evidence may count.
 * `returned` parcels are carried and shown to admins but are NOT scored: no official provider status mapping exists to say whether a return
 * is a customer failure, and nothing is silently counted as delivered or cancelled.
 * Missing evidence NEVER yields high trust: no provider, an invalid phone, a timeout, an error, a malformed response or no parcel history all give 50.
 *
 * WHAT "60", "80" AND "100" MEAN: POINTS on this 0-100 scale, compared with `>=` against configurable thresholds (lowBelow 60, reducedFrom 80, fullAt 100).
 * They are NOT probabilities. Every tier decision is made on the server; the browser can neither supply nor influence a score or an amount.
 */
export type FraudCheckHistory = {
  /** Distinct parcels the provider reports as delivered. */
  delivered: number;
  /** Distinct parcels the provider reports as cancelled. */
  cancelled: number;
  /** Distinct parcels the provider reports as returned. Shown, not scored (see above). */
  returned?: number;
  /**
   * All distinct parcels the provider reports (may include parcels still in transit). Shown, not scored.
   * When supplied it must be >= delivered + cancelled + returned, otherwise the whole answer is treated as inconsistent.
   */
  total?: number;
};

export type FraudUnavailableReason = "no_provider" | "disabled" | "invalid_phone" | "timeout" | "error" | "invalid_response" | "rate_limited" | "auth_failed" | "no_counts";
/** Three clearly separate states: the provider could not answer / answered "no history" / answered with a record. */
export type FraudCheckOutcome =
  | { status: "unavailable"; reason: FraudUnavailableReason }
  | { status: "no_history"; provider: string }
  | { status: "ok"; provider: string; history: FraudCheckHistory };

export type TrustResult = { score: number; insufficientEvidence: boolean; reasons: string[] };

export const NEW_CUSTOMER_SCORE = 50;
export const EMPTY_HISTORY: FraudCheckHistory = { delivered: 0, cancelled: 0 };

/** Usable only if every supplied counter is a non-negative integer. Anything else is conflicting data. */
export function historyIsConsistent(h: FraudCheckHistory): boolean {
  const all = [h.delivered, h.cancelled, ...(h.returned === undefined ? [] : [h.returned]), ...(h.total === undefined ? [] : [h.total])];
  if (!all.every((n) => Number.isInteger(n) && n >= 0)) return false;
  // A reported total smaller than the parts it contains is contradictory data.
  return h.total === undefined || h.total >= h.delivered + h.cancelled + (h.returned ?? 0);
}

/** Total parcels for display: the provider's own total when it gave one, otherwise the sum of the known parts. Never used for scoring. */
export function totalParcels(h: FraudCheckHistory): number {
  return h.total ?? h.delivered + h.cancelled + (h.returned ?? 0);
}

/** Normalises a Bangladeshi mobile number to 01XXXXXXXXX (accepts 01.., 8801.., +8801.., 008801..); null when it is not one. */
export function normalizeBdPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[\s\-().]/g, "");
  if (d.startsWith("00880")) d = "0" + d.slice(5);
  else if (d.startsWith("+880")) d = "0" + d.slice(4);
  else if (d.startsWith("880")) d = "0" + d.slice(3);
  return /^01[3-9]\d{8}$/.test(d) ? d : null;
}

const UNAVAILABLE_TEXT: Record<FraudUnavailableReason, string> = {
  no_provider: "No fraud-check provider is configured",
  disabled: "The fraud check is switched off (FRAUD_CHECK_ENABLED=false)",
  rate_limited: "The fraud-check call budget for this minute was used up, or the provider asked us to slow down",
  auth_failed: "The provider rejected the API credentials",
  no_counts: "The provider answered without parcel counts (the score formula needs counts, so nothing was estimated)",
  invalid_phone: "The order phone is missing or not a valid Bangladesh mobile number",
  timeout: "The fraud-check provider did not answer in time",
  error: "The fraud-check provider could not be reached",
  invalid_response: "The fraud-check provider returned an unusable response",
};

export function computeTrust(h: FraudCheckHistory | null, opts: { phoneVerified?: boolean } = {}): TrustResult {
  if (!h) return { score: NEW_CUSTOMER_SCORE, insufficientEvidence: true, reasons: ["No fraud-check record available: conservative default score."] };
  if (!historyIsConsistent(h)) {
    // Conflicting data is never given the benefit of the doubt.
    return { score: NEW_CUSTOMER_SCORE, insufficientEvidence: true, reasons: ["Fraud-check data was inconsistent and was ignored: conservative default score."] };
  }
  if (h.delivered + h.cancelled === 0) {
    const r = ["Fraud check found no delivered or cancelled parcels for this phone: conservative default score."];
    if (h.returned) r.push(`${h.returned} returned parcel${h.returned === 1 ? "" : "s"} reported; not scored (no documented provider mapping for returns).`);
    return { score: NEW_CUSTOMER_SCORE, insufficientEvidence: true, reasons: r };
  }
  const reasons: string[] = [`Base ${NEW_CUSTOMER_SCORE}.`];
  let score = NEW_CUSTOMER_SCORE;
  if (h.delivered > 0) {
    if (opts.phoneVerified === true) {
      const good = Math.min(h.delivered, 5) * 10;
      score += good; reasons.push(`+${good}: ${h.delivered} delivered parcel${h.delivered === 1 ? "" : "s"} reported by the fraud check (max +50).`);
    } else {
      reasons.push(`+0: ${h.delivered} delivered parcel${h.delivered === 1 ? "" : "s"} reported, not credited because the phone number is not verified.`);
    }
  }
  if (h.cancelled) { const p = h.cancelled * 20; score -= p; reasons.push(`-${p}: ${h.cancelled} cancelled parcel${h.cancelled === 1 ? "" : "s"} reported by the fraud check.`); }
  if (h.returned) reasons.push(`${h.returned} returned parcel${h.returned === 1 ? "" : "s"} reported; not scored (no documented provider mapping for returns).`);
  score = Math.max(0, Math.min(100, score));
  return { score, insufficientEvidence: false, reasons };
}

/** Trust from an explicit fraud-check outcome. Unavailable and no-history both yield the default score but with different, honest reasons. */
export function trustFromOutcome(o: FraudCheckOutcome, opts: { phoneVerified?: boolean } = {}): TrustResult {
  if (o.status === "unavailable") return { score: NEW_CUSTOMER_SCORE, insufficientEvidence: true, reasons: [`${UNAVAILABLE_TEXT[o.reason]}: conservative default score, standard advance rule applies.`] };
  if (o.status === "no_history") return computeTrust(EMPTY_HISTORY, opts);
  return computeTrust(o.history, opts);
}

export type AdvancePolicy = {
  enabled: boolean;
  zones: readonly string[];
  standardAmount: number;
  reducedAmount: number;
  zeroAtFullTrust: boolean;
  lowBelow: number;
  reducedFrom: number;
  fullAt: number;
  /** Low-trust orders need a recorded staff review before dispatch. Treated as ON unless explicitly false. */
  reviewEnabled?: boolean;
};

/** The built-in policy: used when stored settings are missing or invalid. Deliberately conservative (advance required in the outside-Dhaka zone only when enabled). */
export const DEFAULT_POLICY: AdvancePolicy = { enabled: false, zones: ["OUTSIDE_DHAKA"], standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true };
export const ADVANCE_ZONES = ["DHAKA_CITY", "OUTSIDE_DHAKA", "OTHER"] as const;
export const MAX_ADVANCE_AMOUNT = 100000;

export type TrustTier = "low" | "standard" | "reduced" | "full";

/** The tier a score falls in under a policy's thresholds (same comparisons as `decideAdvance`; a test keeps them identical). */
export function tierForScore(policy: Pick<AdvancePolicy, "lowBelow" | "reducedFrom" | "fullAt">, score: number): TrustTier {
  const s = Number.isFinite(score) ? Math.min(Math.max(score, 0), 100) : NEW_CUSTOMER_SCORE;
  if (s >= policy.fullAt) return "full";
  if (s >= policy.reducedFrom) return "reduced";
  if (s >= policy.lowBelow) return "standard";
  return "low";
}

export type AdvanceDecision = {
  required: number;
  tier: TrustTier | null;
  /** True for the lowest tier: staff should look at the order before dispatch. */
  needsReview: boolean;
  explanation: string;
};

/** Which advance the order needs. Amounts are capped at the order total; the advance is PART of the total, never an extra fee. */
export function decideAdvance(policy: AdvancePolicy, i: { zone: string; orderTotal: number; trustScore: number; zoneConflict?: boolean }): AdvanceDecision {
  if (!policy.enabled) return { required: 0, tier: null, needsReview: false, explanation: "Advance payments are not enabled." };
  if (!policy.zones.includes(i.zone)) return { required: 0, tier: null, needsReview: false, explanation: "No advance is required for this delivery zone." };
  // A score that is not a finite number in [0,100] is treated as the conservative default, never as "high".
  const s = Number.isFinite(i.trustScore) ? Math.min(Math.max(i.trustScore, 0), 100) : NEW_CUSTOMER_SCORE;
  let tier: TrustTier;
  let amount: number;
  if (s >= policy.fullAt) {
    tier = "full";
    amount = policy.zeroAtFullTrust ? 0 : policy.reducedAmount;
  } else if (s >= policy.reducedFrom) { tier = "reduced"; amount = policy.reducedAmount; }
  else if (s >= policy.lowBelow) { tier = "standard"; amount = policy.standardAmount; }
  else { tier = "low"; amount = policy.standardAmount; }
  const required = Math.round(Math.min(Math.max(amount, 0), Math.max(i.orderTotal, 0)) * 100) / 100;
  const reviewOn = policy.reviewEnabled !== false;
  return {
    required,
    tier,
    // Low tier, or the claimed delivery zone contradicts the address: a person must look before dispatch (when the review rule is enabled).
    needsReview: reviewOn && (tier === "low" || Boolean(i.zoneConflict)),
    explanation: `Trust score ${s}/100 → ${tier} tier${required === 0 ? " (no advance)" : ""}${i.zoneConflict ? "; delivery zone does not match the address, stricter zone applied" : ""}.`,
  };
}

const isAmount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_ADVANCE_AMOUNT && Math.round(n * 100) / 100 === n;

/** Returns an error message or null. Prevents overlapping/contradictory thresholds and nonsensical amounts. */
export function validateAdvancePolicy(p: AdvancePolicy): string | null {
  const ints = [p.lowBelow, p.reducedFrom, p.fullAt];
  if (!ints.every((n) => Number.isInteger(n))) return "Trust thresholds must be whole numbers.";
  if (!(p.lowBelow >= 1 && p.lowBelow <= p.reducedFrom && p.reducedFrom <= p.fullAt && p.fullAt <= 100)) return "Thresholds must satisfy 1 ≤ low ≤ reduced ≤ full ≤ 100 in that order.";
  if (p.lowBelow === p.reducedFrom && p.reducedFrom === p.fullAt) return "At least two different trust tiers are required.";
  if (!isAmount(p.standardAmount) || !isAmount(p.reducedAmount)) return `Advance amounts must be between 0 and ${MAX_ADVANCE_AMOUNT} with at most 2 decimals.`;
  if (p.reducedAmount > p.standardAmount) return "The reduced advance cannot be larger than the standard advance.";
  if (p.enabled && p.zones.length === 0) return "Choose at least one delivery zone for the advance.";
  if (p.zones.some((z) => !(ADVANCE_ZONES as readonly string[]).includes(z))) return "Unknown delivery zone.";
  if (p.enabled && p.standardAmount === 0 && !p.zeroAtFullTrust) return "A standard advance of 0 would make the policy meaningless: set an amount or disable the advance.";
  return null;
}

/** Stored settings that fail validation (hand-edited database, old data) never silently weaken the policy: the built-in defaults apply and `problem` says why. */
export function sanitizePolicy(raw: AdvancePolicy): { policy: AdvancePolicy; problem: string | null } {
  const problem = validateAdvancePolicy(raw);
  if (!problem) return { policy: raw, problem: null };
  return { policy: { ...DEFAULT_POLICY, enabled: raw.enabled, zones: raw.zones.filter((z) => (ADVANCE_ZONES as readonly string[]).includes(z)).length ? raw.zones.filter((z) => (ADVANCE_ZONES as readonly string[]).includes(z)) : DEFAULT_POLICY.zones, reviewEnabled: raw.reviewEnabled !== false }, problem };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Delivery-zone evidence. The zone the customer picked decides the delivery charge AND whether an advance is asked for, so a "Dhaka City" claim
// is cross-checked against the address text. Free-text addresses can't be validated exactly: a mismatch never rejects the order, it makes the
// policy use the STRICTER zone and flags the order for staff review.
// ---------------------------------------------------------------------------------------------------------------------------------
const DHAKA_MARKERS = [
  "dhaka", "dacca", "ঢাকা", "uttara", "mirpur", "dhanmondi", "gulshan", "banani", "mohammadpur", "motijheel", "badda", "rampura", "bashundhara", "khilgaon",
  "tejgaon", "farmgate", "jatrabari", "demra", "malibagh", "mogbazar", "shantinagar", "lalbagh", "wari", "sutrapur", "kamrangirchar", "pallabi", "kafrul", "shyamoli", "kalabagan", "paltan", "kakrail", "baridhara", "niketan", "agargaon",
];

export function addressLooksLikeDhaka(a: { city?: string | null; state?: string | null; line1?: string | null; line2?: string | null }): boolean {
  const text = [a.city, a.state, a.line1, a.line2].filter(Boolean).join(" ").toLowerCase();
  return DHAKA_MARKERS.some((m) => text.includes(m));
}

/** The zone used for the ADVANCE decision. Only ever stricter than the claim, never looser. */
export function policyZoneFor(claimed: string, address: Parameters<typeof addressLooksLikeDhaka>[0]): { zone: string; conflict: boolean } {
  if (claimed === "DHAKA_CITY" && !addressLooksLikeDhaka(address)) return { zone: "OUTSIDE_DHAKA", conflict: true };
  return { zone: claimed, conflict: false };
}

/** Remaining amount the customer still owes on an order, given VERIFIED advance payments. */
export function remainingBalance(total: number, advancePaid: number): number {
  return Math.round(Math.max(total - advancePaid, 0) * 100) / 100;
}

/** Order-level payment status from verified amounts. COD balance does not count as paid until collected. */
export function paymentStatusFor(total: number, verifiedPaid: number): "UNPAID" | "PARTIALLY_PAID" | "PAID" {
  if (verifiedPaid <= 0) return "UNPAID";
  return verifiedPaid + 0.005 >= total ? "PAID" : "PARTIALLY_PAID";
}

/**
 * ONE derivation of an order's money position from RECORDS, never from claims:
 *   paid      = Σ amounts of payments with status PAID (verified by staff)         — a pending claim contributes 0
 *   refunded  = Σ recorded refunds on the order, capped at what was paid
 *   balance   = total − paid                                                       — what is still to be collected (COD on delivery)
 *   status    = UNPAID | PARTIALLY_PAID | PAID from paid vs total; REFUNDED / PARTIALLY_REFUNDED once refunds are recorded against paid money
 *   advanceStillRequired = max(required − paid, 0), or 0 when staff waived it (a waiver is a decision, it adds no money)
 * A partial payment can never produce PAID (paymentStatusFor needs paid ≥ total).
 */
export function derivePayment(i: {
  total: number;
  advanceRequired: number;
  waived: boolean;
  payments: readonly { status: string; amount: number }[];
  refunded?: number;
}): { paid: number; refunded: number; balance: number; status: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED"; advanceStillRequired: number; unverifiedClaims: number } {
  const p = (n: number) => Math.round(n * 100);
  const paid = i.payments.reduce((s, x) => (x.status === "PAID" ? s + p(x.amount) : s), 0);
  const claims = i.payments.reduce((s, x) => (x.status === "PENDING" ? s + p(x.amount) : s), 0);
  const refunded = Math.min(Math.max(p(i.refunded ?? 0), 0), paid);
  const total = p(i.total);
  let status: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" = paymentStatusFor(total / 100, paid / 100);
  if (paid > 0 && refunded > 0) status = refunded >= paid ? "REFUNDED" : "PARTIALLY_REFUNDED";
  return {
    paid: paid / 100, refunded: refunded / 100, balance: Math.max(total - paid, 0) / 100, status,
    advanceStillRequired: i.waived ? 0 : Math.max(p(i.advanceRequired) - paid, 0) / 100,
    unverifiedClaims: claims / 100,
  };
}
