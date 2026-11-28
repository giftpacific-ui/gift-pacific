import type { CombinedReport } from "@/lib/courier-intelligence/combine";
import type { IntelProviderKey } from "@/lib/courier-intelligence/types";

/**
 * How courier history becomes an advance decision input. There is NO default score: without reliable evidence the answer is "unrated",
 * and "unrated" is handled conservatively by the advance policy (standard advance, staff review), exactly as an unavailable check always was.
 *
 *  rated        enough comparable evidence: the delivery success rate (a percentage) is used
 *  no_history   the couriers that answered have nothing on record for the number
 *  insufficient history exists but too little (sample / provider coverage) to rely on, e.g. 1 delivered of 1 is 100% but is not a reliable rate
 *  unavailable  no courier gave usable data (not configured, error, timeout...): an outage never changes the decision for the better
 *  invalid_phone the phone is not a Bangladesh mobile number
 *
 * Reducing the advance (rewardAllowed) needs ALL of: a rated state, the policy's reward switch ON, and either a verified phone or the policy's
 * explicit acceptance of unverified-phone history. Negative evidence always counts. A customer types the phone, so crediting someone else's good
 * history is the risk the verified-phone rule exists for.
 */
export type EvidencePolicy = {
  /** Minimum delivered + cancelled parcels before the rate may be used. */
  minSample: number;
  /** Minimum number of couriers whose counts contributed. */
  minProviders: number;
  /** Evidence older than this is not used (seconds). */
  maxAgeSeconds: number;
  /** Positive evidence may lower the advance at all (off by default). */
  rewardEnabled: boolean;
  /** Positive evidence may count even though the phone number is not verified (off by default). */
  creditUnverifiedPhone: boolean;
};

export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = { minSample: 5, minProviders: 1, maxAgeSeconds: 3600, rewardEnabled: false, creditUnverifiedPhone: false };

export type TrustState = "rated" | "no_history" | "insufficient" | "unavailable" | "invalid_phone";

export type TrustAssessment = {
  state: TrustState;
  /** Delivery success rate in percent; non-null ONLY when state is "rated". */
  rate: number | null;
  /** The rate the couriers show even when the sample is too small to rely on (display for staff; never used for a decision). */
  observedRate: number | null;
  sample: number;
  providers: IntelProviderKey[];
  /** May positive evidence lower the advance for this order? */
  rewardAllowed: boolean;
  /** Evidence a staff member should treat with care (small sample, single courier, unavailable...). */
  insufficientEvidence: boolean;
  reasons: string[];
};

export function validateEvidencePolicy(p: EvidencePolicy): string | null {
  const int = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!int(p.minSample, 1, 100)) return "The minimum sample must be a whole number from 1 to 100.";
  if (!int(p.minProviders, 1, 3)) return "The minimum number of couriers must be 1, 2 or 3.";
  if (!int(p.maxAgeSeconds, 60, 86_400)) return "The maximum evidence age must be between 60 and 86400 seconds.";
  return null;
}

export function assessTrust(input: {
  combined: CombinedReport | null;
  invalidPhone?: boolean;
  phoneVerified: boolean;
  policy: EvidencePolicy;
  /** Age of the oldest contributing answer, in seconds (omit when unknown: the caller already filtered by age). */
  oldestAgeSeconds?: number | null;
}): TrustAssessment {
  const base = { rate: null, observedRate: null, sample: 0, providers: [] as IntelProviderKey[], rewardAllowed: false, insufficientEvidence: true } as const;
  if (input.invalidPhone) return { ...base, state: "invalid_phone", reasons: ["The phone number is not a valid Bangladesh mobile number: no courier history was looked up."] };
  const c = input.combined;
  if (!c || c.state === "unavailable") return { ...base, state: "unavailable", reasons: ["No courier gave usable history for this phone: it is treated as unrated (standard advance, staff review). A courier outage never lowers the advance."] };
  if (c.state === "insufficient") return { ...base, state: "insufficient", reasons: ["The couriers gave only percentages without parcel counts: no reliable rate exists, so the number is treated as unrated."] };
  if (c.state === "no_history") return { ...base, state: "no_history", providers: c.contributing, reasons: ["The couriers that answered have no delivery or cancellation on record for this number: unrated."] };

  const reasons: string[] = [`${c.delivered} delivered of ${c.finalOutcomes} delivered or cancelled parcels = ${c.deliverySuccessRate}% (${c.contributing.join(", ")}).`];
  const common = { observedRate: c.deliverySuccessRate, sample: c.finalOutcomes, providers: c.contributing };
  if (input.oldestAgeSeconds != null && input.oldestAgeSeconds > input.policy.maxAgeSeconds) {
    return { ...base, ...common, state: "insufficient", reasons: [...reasons, `The newest check is older than the allowed ${input.policy.maxAgeSeconds} seconds: not used.`] };
  }
  if (c.finalOutcomes < input.policy.minSample) {
    return { ...base, ...common, state: "insufficient", reasons: [...reasons, `Only ${c.finalOutcomes} parcel${c.finalOutcomes === 1 ? "" : "s"} counted; at least ${input.policy.minSample} are needed before the rate is relied on: unrated.`] };
  }
  if (c.contributing.length < input.policy.minProviders) {
    return { ...base, ...common, state: "insufficient", reasons: [...reasons, `${c.contributing.length} courier${c.contributing.length === 1 ? "" : "s"} contributed; the policy needs ${input.policy.minProviders}: unrated.`] };
  }
  const unlocked = input.policy.rewardEnabled && (input.phoneVerified || input.policy.creditUnverifiedPhone);
  if (!input.policy.rewardEnabled) reasons.push("Reduced advances are switched off in the policy, so a good record does not lower the advance.");
  else if (!unlocked) reasons.push("The phone number is not verified, so a good record is not credited (only a poor one counts).");
  return { state: "rated", rate: c.deliverySuccessRate, observedRate: c.deliverySuccessRate, sample: c.finalOutcomes, providers: c.contributing, rewardAllowed: unlocked, insufficientEvidence: false, reasons };
}
