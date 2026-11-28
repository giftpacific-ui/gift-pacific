/**
 * Advance-payment + trust policy (pure, server-authoritative).
 *
 * P6 redesign. The "trust" input is the customer's DELIVERY SUCCESS RATE from the couriers' own history for the order's phone number (see
 * lib/courier-intelligence): delivered / (delivered + cancelled), in percent. There is NO default score. Without reliable evidence (no history,
 * too small a sample, too few couriers, a courier outage, an invalid phone) the number is "unrated", which is handled conservatively: the standard
 * advance and, when the review rule is on, a staff review. An outage can never lower an advance. Our own website order history is never used.
 *
 * Tiers compare the RATE (a percentage, `>=`) with configurable lines (lowBelow 60, reducedFrom 80, fullAt 100):
 *   unrated                          standard advance (+ review when enabled)
 *   rate  < lowBelow                 low: standard advance (+ review when enabled)
 *   rate >= lowBelow                 standard: standard advance
 *   rate >= reducedFrom              reduced: ONLY when positive evidence may count (policy reward switch ON and phone verified or explicitly accepted)
 *   rate >= fullAt                   full: same condition; no advance only if "zero at full trust" is on, otherwise the reduced advance
 * Every decision is made on the server; the browser can neither supply nor influence a rate, a tier or an amount.
 * It is a transparent rule, not a validated prediction and not a fraud verdict.
 */
import { DEFAULT_EVIDENCE_POLICY, validateEvidencePolicy, type EvidencePolicy } from "@/lib/courier-intelligence/trust";

/** The evidence rules of a policy, with the conservative defaults for anything missing. */
export function evidencePolicyOf(p: Pick<AdvancePolicy, "minSample" | "minProviders" | "maxAgeSeconds" | "rewardEnabled" | "creditUnverifiedPhone">): EvidencePolicy {
  return {
    minSample: p.minSample ?? DEFAULT_EVIDENCE_POLICY.minSample,
    minProviders: p.minProviders ?? DEFAULT_EVIDENCE_POLICY.minProviders,
    maxAgeSeconds: p.maxAgeSeconds ?? DEFAULT_EVIDENCE_POLICY.maxAgeSeconds,
    rewardEnabled: p.rewardEnabled === true,
    creditUnverifiedPhone: p.creditUnverifiedPhone === true,
  };
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
  /** Evidence rules (P6). Optional so older stored policies keep working: missing values mean the conservative defaults. */
  minSample?: number;
  minProviders?: number;
  maxAgeSeconds?: number;
  rewardEnabled?: boolean;
  creditUnverifiedPhone?: boolean;
};

/** The built-in policy: used when stored settings are missing or invalid. Deliberately conservative (advance required in the outside-Dhaka zone only when enabled). */
export const DEFAULT_POLICY: AdvancePolicy = { enabled: false, zones: ["OUTSIDE_DHAKA"], standardAmount: 200, reducedAmount: 100, zeroAtFullTrust: false, lowBelow: 60, reducedFrom: 80, fullAt: 100, reviewEnabled: true, minSample: 5, minProviders: 1, maxAgeSeconds: 3600, rewardEnabled: false, creditUnverifiedPhone: false };
export const ADVANCE_ZONES = ["DHAKA_CITY", "OUTSIDE_DHAKA", "OTHER"] as const;
export const MAX_ADVANCE_AMOUNT = 100000;

export type TrustTier = "unrated" | "low" | "standard" | "reduced" | "full";

/** The tier a rate falls in under a policy (same comparisons as `decideAdvance`; a test keeps them identical). null rate = unrated. */
export function tierForRate(policy: Pick<AdvancePolicy, "lowBelow" | "reducedFrom" | "fullAt">, rate: number | null, rewardAllowed: boolean): TrustTier {
  if (rate === null || !Number.isFinite(rate)) return "unrated";
  const r = Math.min(Math.max(rate, 0), 100);
  if (r < policy.lowBelow) return "low";
  if (!rewardAllowed) return "standard";
  if (r >= policy.fullAt) return "full";
  if (r >= policy.reducedFrom) return "reduced";
  return "standard";
}

export type AdvanceDecision = {
  required: number;
  tier: TrustTier | null;
  /** True for the unrated and low tiers: staff should look at the order before dispatch. */
  needsReview: boolean;
  explanation: string;
};

/**
 * Which advance the order needs. Amounts are capped at the order total; the advance is PART of the total, never an extra fee.
 * `rate` is null when there is no reliable courier evidence; `rewardAllowed` says whether positive evidence may lower the advance at all.
 */
export function decideAdvance(policy: AdvancePolicy, i: { zone: string; orderTotal: number; rate: number | null; rewardAllowed: boolean; zoneConflict?: boolean }): AdvanceDecision {
  if (!policy.enabled) return { required: 0, tier: null, needsReview: false, explanation: "Advance payments are not enabled." };
  if (!policy.zones.includes(i.zone)) return { required: 0, tier: null, needsReview: false, explanation: "No advance is required for this delivery zone." };
  const tier = tierForRate(policy, i.rate, i.rewardAllowed);
  const amount = tier === "full" ? (policy.zeroAtFullTrust ? 0 : policy.reducedAmount) : tier === "reduced" ? policy.reducedAmount : policy.standardAmount;
  const required = Math.round(Math.min(Math.max(amount, 0), Math.max(i.orderTotal, 0)) * 100) / 100;
  const reviewOn = policy.reviewEnabled !== false;
  const basis = i.rate === null ? "No reliable courier history (unrated)" : `Courier delivery success rate ${i.rate}%`;
  return {
    required,
    tier,
    // Unrated or low, or the claimed delivery zone contradicts the address: a person must look before dispatch (when the review rule is enabled).
    needsReview: reviewOn && (tier === "unrated" || tier === "low" || Boolean(i.zoneConflict)),
    explanation: `${basis} → ${tier} tier${required === 0 ? " (no advance)" : ""}${i.zoneConflict ? "; delivery zone does not match the address, stricter zone applied" : ""}.`,
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
  return validateEvidencePolicy(evidencePolicyOf(p));
}

/** Stored settings that fail validation (hand-edited database, old data) never silently weaken the policy: the built-in defaults apply and `problem` says why. */
export function sanitizePolicy(raw: AdvancePolicy): { policy: AdvancePolicy; problem: string | null } {
  const problem = validateAdvancePolicy(raw);
  if (!problem) return { policy: raw, problem: null };
  return { policy: { ...DEFAULT_POLICY, enabled: raw.enabled, rewardEnabled: false, creditUnverifiedPhone: false, zones: raw.zones.filter((z) => (ADVANCE_ZONES as readonly string[]).includes(z)).length ? raw.zones.filter((z) => (ADVANCE_ZONES as readonly string[]).includes(z)) : DEFAULT_POLICY.zones, reviewEnabled: raw.reviewEnabled !== false }, problem };
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
