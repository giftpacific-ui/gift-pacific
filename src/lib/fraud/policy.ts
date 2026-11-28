/**
 * Fraud-risk policy (pure). One definition of the levels, the default weights and the validation of anything an admin can configure.
 *
 * ## What the score is
 * A 0-100 sum of EXPLAINED signals, each backed by data the system really holds. It is evidence for a human decision, not a verdict and not a
 * probability. Higher = riskier (the existing advance "trust" score in advance-policy.ts is the opposite scale and is a different, courier-evidence
 * signal; it is consumed here, never recomputed or changed).
 *
 * ## Levels (defaults, configurable): LOW 0-29, MEDIUM 30-59, HIGH 60-79, CRITICAL 80-100
 *  LOW: normal workflow. MEDIUM: warning shown to admins, normal manual confirmation. HIGH: a recorded review (with a reason) is required before
 *  the order can be confirmed. CRITICAL: the order is held for manual review; same recorded review, restricted to the configured reviewers.
 */
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const LEVEL_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export const FRAUD_MODES = ["OFF", "ADVISORY", "ENFORCE"] as const;
export type FraudMode = (typeof FRAUD_MODES)[number];

export const SCALED_SIGNALS = ["PRIOR_CANCELLED", "PRIOR_FAILED_DELIVERY", "PRIOR_FRAUD_REJECTED", "ADVANCE_REJECTED", "PHONE_BURST", "DUPLICATE_CART"] as const;
export const FLAT_RISK_SIGNALS = [
  "ADDRESS_MANY_IDENTITIES", "EMAIL_MANY_PHONES", "IP_MANY_IDENTITIES", "ADDRESS_QUALITY", "ZONE_MISMATCH", "LOW_TRUST_EVIDENCE", "HIGH_VALUE_FIRST_ORDER",
  "BLOCKED_PHONE", "BLOCKED_EMAIL", "BLOCKED_IP",
] as const;
export const CREDIT_SIGNALS = ["ALLOW_PHONE", "ALLOW_EMAIL", "ALLOW_IP", "DELIVERED_KNOWN_ADDRESS", "VERIFIED_ADVANCE_HISTORY"] as const;

export type ScaledSignal = (typeof SCALED_SIGNALS)[number];
export type FlatRiskSignal = (typeof FLAT_RISK_SIGNALS)[number];
export type CreditSignal = (typeof CREDIT_SIGNALS)[number];
export type SignalCode = ScaledSignal | FlatRiskSignal | CreditSignal | "CREDIT_CAP";

export type FraudPolicy = {
  mode: FraudMode;
  thresholds: { medium: number; high: number; critical: number };
  /** Lowest level that needs a recorded review before confirmation (ENFORCE only). */
  reviewFrom: "HIGH" | "CRITICAL";
  /** What a phone/e-mail BLOCK match does at checkout: HOLD (accept, force manual review) or REJECT (refuse to place the order). IP blocks only ever HOLD. */
  blockAction: "HOLD" | "REJECT";
  /** Admin user ids allowed to review CRITICAL orders. Empty = any active admin. */
  criticalReviewerIds: string[];
  ipRetentionDays: number;
  windows: { burstHours: number; duplicateMinutes: number; addressDays: number; emailDays: number; ipHours: number };
  counts: { burstFree: number; addressPhones: number; emailPhones: number; ipPhones: number };
  highValueAmount: number;
  /** Most points that all credits (allow lists, known-address history, verified advances) may take away together. */
  maxCredit: number;
  scaled: Record<ScaledSignal, { perUnit: number; cap: number }>;
  flat: Record<FlatRiskSignal | CreditSignal, number>;
};

export const DEFAULT_FRAUD_POLICY: FraudPolicy = {
  mode: "ENFORCE",
  thresholds: { medium: 30, high: 60, critical: 80 },
  reviewFrom: "HIGH",
  blockAction: "HOLD",
  criticalReviewerIds: [],
  ipRetentionDays: 30,
  windows: { burstHours: 24, duplicateMinutes: 30, addressDays: 7, emailDays: 30, ipHours: 24 },
  counts: { burstFree: 1, addressPhones: 3, emailPhones: 2, ipPhones: 5 },
  highValueAmount: 15000,
  maxCredit: 40,
  scaled: {
    PRIOR_CANCELLED: { perUnit: 8, cap: 24 },
    PRIOR_FAILED_DELIVERY: { perUnit: 15, cap: 45 },
    PRIOR_FRAUD_REJECTED: { perUnit: 25, cap: 50 },
    ADVANCE_REJECTED: { perUnit: 10, cap: 20 },
    PHONE_BURST: { perUnit: 6, cap: 24 },
    DUPLICATE_CART: { perUnit: 15, cap: 30 },
  },
  flat: {
    ADDRESS_MANY_IDENTITIES: 8, EMAIL_MANY_PHONES: 12, IP_MANY_IDENTITIES: 6, ADDRESS_QUALITY: 10, ZONE_MISMATCH: 8, LOW_TRUST_EVIDENCE: 20, HIGH_VALUE_FIRST_ORDER: 10,
    BLOCKED_PHONE: 100, BLOCKED_EMAIL: 100, BLOCKED_IP: 60,
    ALLOW_PHONE: -30, ALLOW_EMAIL: -30, ALLOW_IP: -10, DELIVERED_KNOWN_ADDRESS: -12, VERIFIED_ADVANCE_HISTORY: -8,
  },
};

/** Human labels (shown in the admin) for every signal, with the data behind it. */
export const SIGNAL_LABELS: Record<SignalCode, string> = {
  PRIOR_CANCELLED: "Earlier cancelled orders",
  PRIOR_FAILED_DELIVERY: "Earlier failed deliveries",
  PRIOR_FRAUD_REJECTED: "Earlier orders rejected in fraud review",
  ADVANCE_REJECTED: "Earlier advance payments that could not be verified",
  PHONE_BURST: "Many orders from this phone in a short time",
  DUPLICATE_CART: "Identical cart ordered again very recently",
  ADDRESS_MANY_IDENTITIES: "Same address used with several different phone numbers",
  EMAIL_MANY_PHONES: "Same e-mail used with several different phone numbers",
  IP_MANY_IDENTITIES: "Many different phone numbers from one network address (weak signal)",
  ADDRESS_QUALITY: "Address or name looks incomplete or like a placeholder",
  ZONE_MISMATCH: "Delivery zone does not match the address (existing check)",
  LOW_TRUST_EVIDENCE: "Courier fraud-check evidence is poor (existing trust score)",
  HIGH_VALUE_FIRST_ORDER: "High-value order from a customer with no delivered history",
  BLOCKED_PHONE: "Phone number is on the block list",
  BLOCKED_EMAIL: "E-mail address is on the block list",
  BLOCKED_IP: "Network address is on the block list",
  ALLOW_PHONE: "Phone number is on the allow list",
  ALLOW_EMAIL: "E-mail address is on the allow list",
  ALLOW_IP: "Network address is on the allow list",
  DELIVERED_KNOWN_ADDRESS: "Earlier delivered order to this same address by this phone",
  VERIFIED_ADVANCE_HISTORY: "Earlier advance payment verified by staff",
  CREDIT_CAP: "Credits limited to the configured maximum",
};

export function levelForScore(score: number, t: FraudPolicy["thresholds"]): RiskLevel {
  const s = Number.isFinite(score) ? score : 0;
  if (s >= t.critical) return "CRITICAL";
  if (s >= t.high) return "HIGH";
  if (s >= t.medium) return "MEDIUM";
  return "LOW";
}

/** True when this level needs a recorded review under the policy. Only ENFORCE gates; ADVISORY and OFF never block an order. */
export function reviewRequiredFor(level: RiskLevel, p: Pick<FraudPolicy, "mode" | "reviewFrom">): boolean {
  return p.mode === "ENFORCE" && LEVEL_RANK[level] >= LEVEL_RANK[p.reviewFrom];
}

const isInt = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/** Returns an error message or null. Prevents overlapping thresholds and nonsensical weights. */
export function validateFraudPolicy(p: FraudPolicy): string | null {
  if (!(FRAUD_MODES as readonly string[]).includes(p.mode)) return "Unknown mode.";
  const t = p.thresholds;
  if (![t.medium, t.high, t.critical].every((n) => isInt(n, 1, 100))) return "Thresholds must be whole numbers between 1 and 100.";
  if (!(t.medium < t.high && t.high < t.critical)) return "Thresholds must satisfy medium < high < critical.";
  if (p.reviewFrom !== "HIGH" && p.reviewFrom !== "CRITICAL") return "Review can be required from HIGH or CRITICAL only.";
  if (p.blockAction !== "HOLD" && p.blockAction !== "REJECT") return "Unknown block action.";
  if (!Array.isArray(p.criticalReviewerIds) || p.criticalReviewerIds.length > 50 || p.criticalReviewerIds.some((x) => typeof x !== "string" || !x || x.length > 64)) return "Invalid reviewer list.";
  if (!isInt(p.ipRetentionDays, 1, 365)) return "IP retention must be 1-365 days.";
  const w = p.windows;
  if (!isInt(w.burstHours, 1, 168) || !isInt(w.duplicateMinutes, 1, 1440) || !isInt(w.addressDays, 1, 90) || !isInt(w.emailDays, 1, 365) || !isInt(w.ipHours, 1, 168)) return "A time window is out of range.";
  const c = p.counts;
  if (!isInt(c.burstFree, 0, 20) || !isInt(c.addressPhones, 2, 50) || !isInt(c.emailPhones, 2, 50) || !isInt(c.ipPhones, 2, 100)) return "A count threshold is out of range.";
  if (typeof p.highValueAmount !== "number" || !Number.isFinite(p.highValueAmount) || p.highValueAmount < 0 || p.highValueAmount > 10_000_000) return "High-value amount is out of range.";
  if (!isInt(p.maxCredit, 0, 100)) return "Maximum credit must be 0-100.";
  for (const code of SCALED_SIGNALS) {
    const s = p.scaled[code];
    if (!s || !isInt(s.perUnit, 0, 100) || !isInt(s.cap, 0, 100)) return `Weight for ${code} is out of range.`;
  }
  for (const code of [...FLAT_RISK_SIGNALS, ...CREDIT_SIGNALS] as const) {
    const v = p.flat[code];
    const credit = (CREDIT_SIGNALS as readonly string[]).includes(code);
    if (!isInt(v, credit ? -100 : 0, credit ? 0 : 100)) return `Weight for ${code} must be ${credit ? "between -100 and 0" : "between 0 and 100"}.`;
  }
  return null;
}

type Deep<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Deep<T[K]>) : T[K] };

function merge<T extends Record<string, unknown>>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (!(k in base)) continue; // unknown keys are ignored, never trusted
    const b = base[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) ? merge(b as Record<string, unknown>, v) : v;
  }
  return out as T;
}

/** Stored JSON (or an admin submission) merged over the defaults. Invalid input NEVER weakens protection: the defaults apply and `problem` says why. */
export function resolveFraudPolicy(raw: unknown): { policy: FraudPolicy; problem: string | null } {
  const merged = merge(DEFAULT_FRAUD_POLICY as unknown as Record<string, unknown>, raw) as unknown as FraudPolicy;
  const problem = validateFraudPolicy(merged);
  return problem ? { policy: DEFAULT_FRAUD_POLICY, problem } : { policy: merged, problem: null };
}

export type { Deep as FraudPolicyOverride };
