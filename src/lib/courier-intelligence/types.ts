/**
 * Courier intelligence: a normalised, provider-neutral report of a phone number's delivery history across courier networks.
 * Pure types and constants only (safe to import from client components for DISPLAY; never for decisions).
 *
 * Rules every adapter and consumer relies on:
 *  - A metric a provider does not report is `null`, never 0. Missing data is not "no parcels".
 *  - Provider status meanings stay separate (a provider's "cancelled" is not assumed to equal another's "returned" or "failed").
 *  - A percentage without counts is carried as a percentage only; it is never turned into parcel counts.
 */
export const INTEL_PROVIDERS = ["steadfast", "pathao", "redx"] as const;
export type IntelProviderKey = (typeof INTEL_PROVIDERS)[number];
export const isIntelProvider = (v: unknown): v is IntelProviderKey => typeof v === "string" && (INTEL_PROVIDERS as readonly string[]).includes(v);

/** Why a provider gave no usable answer. Reason CODES only: never provider text, URLs, phone numbers or credentials. */
export type FailureReason = "disabled" | "invalid_phone" | "timeout" | "error" | "invalid_response" | "rate_limited" | "auth_failed";

/**
 *  ok            the provider answered with counts
 *  no_history    the provider answered: nothing on record for this number (a real answer)
 *  unavailable   configured, but this attempt failed (see `reason`)
 *  not_configured the courier's credentials are missing or the courier is switched off
 *  unsupported   the courier offers no customer-history lookup we could verify (nothing is called, nothing is faked)
 */
export type LookupStatus = "ok" | "no_history" | "unavailable" | "not_configured" | "unsupported";

export type MetricName = "delivered" | "cancelled" | "returned" | "failed" | "total" | "deliveryRate" | "cancellationRate" | "fraudReports";

export type ProviderReport = {
  provider: IntelProviderKey;
  status: LookupStatus;
  reason: FailureReason | null;
  /** ISO time the provider was asked (or the time of the stored answer). */
  checkedAt: string;
  /** Served from the stored cache instead of a new provider call. */
  cached: boolean;
  delivered: number | null;
  cancelled: number | null;
  returned: number | null;
  failed: number | null;
  /** All parcels the provider counts for this number, when it says so. May include parcels still in progress. */
  total: number | null;
  /** Percentages exactly as the provider reported them (0-100). Display only: never combined, never scored. */
  reportedDeliveryRate: number | null;
  reportedCancellationRate: number | null;
  /** How many fraud reports the provider lists against the number. Only the COUNT is kept (report contents may identify other merchants). Never scored. */
  fraudReports: number | null;
};

export const EMPTY_METRICS = {
  delivered: null, cancelled: null, returned: null, failed: null, total: null,
  reportedDeliveryRate: null, reportedCancellationRate: null, fraudReports: null,
} as const;

export const FAILURE_TEXT: Record<FailureReason, string> = {
  disabled: "The courier history check is switched off (FRAUD_CHECK_ENABLED=false)",
  invalid_phone: "The phone number is missing or not a valid Bangladesh mobile number",
  timeout: "The courier did not answer in time",
  error: "The courier could not be reached",
  invalid_response: "The courier returned an unusable response",
  rate_limited: "The lookup budget for this courier was used up, or the courier asked us to slow down",
  auth_failed: "The courier rejected the API credentials",
};

/** What a courier documents about itself. Capability is a CODE fact: `unsupported` couriers have no adapter and are never called. */
export type ProviderDescriptor = {
  key: IntelProviderKey;
  label: string;
  capability: "supported" | "unsupported";
  supportedMetrics: readonly MetricName[];
  unsupportedMetrics: readonly MetricName[];
  /** Where the contract was checked, when, and whether any real call was ever made. Shown to admins; recorded in the handoff. */
  verification: {
    state: "vendor_documented" | "not_documented";
    source: string;
    verifiedOn: string;
    liveTested: false;
  };
  /** One line: what the lookup returns, or why there is none. */
  summary: string;
  /** What the provider's own "cancelled"/"returned" mean, as far as it documents them. Counts are never merged across different meanings. */
  semantics: string;
  endpoint: string | null;
};

/**
 * The provider-neutral contract every history adapter maps its courier's answer to. An adapter returns EITHER metrics OR a failure reason code,
 * never both and never a guess: a metric its courier does not report is `null`. Whatever an adapter returns is checked again by the verification
 * gate (lib/courier-intelligence/verify.ts) before it can be stored or combined, so a faulty adapter cannot inject numbers.
 */
export type HistoryMetrics = Omit<ProviderReport, "provider" | "status" | "reason" | "checkedAt" | "cached"> & {
  /** The courier answered and has nothing at all on record for this number. */
  empty: boolean;
};
export type HistoryAnswer = { ok: true; metrics: HistoryMetrics } | { ok: false; reason: FailureReason };
export interface HistoryAdapter {
  /** Which courier this adapter speaks to. The service refuses an adapter whose key is not the courier it was registered for. */
  readonly key: IntelProviderKey;
  /** Read-only lookup of one NORMALISED Bangladesh mobile number (01XXXXXXXXX). Must not throw; may be slow (the service enforces the timeout). */
  lookup(phone: string, timeoutMs: number): Promise<HistoryAnswer>;
}
