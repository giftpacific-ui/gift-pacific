import { providerDescriptor } from "@/lib/courier-intelligence/registry";
import { INTEL_PROVIDERS, type IntelProviderKey, type ProviderReport } from "@/lib/courier-intelligence/types";

/**
 * The combined delivery report. Rules (all enforced here, all tested):
 *  1. Only provider-reported COUNTS are used. A provider that gave no counts contributes nothing (missing data is never zero).
 *  2. A provider that answered "no history" DID answer: it contributes zero, which is real information.
 *  3. A percentage without counts is shown on its own and never enters the combined figures (no verified denominator).
 *  4. Success rate = delivered / (delivered + cancelled), over contributing providers. Returned and failed counts, where a provider reports them,
 *     are shown separately and are NOT in the denominator (their meaning differs by courier and is not documented as a final non-delivery).
 *     Parcels a provider counts in its total that are neither delivered nor cancelled are shown as "not classified" and are also excluded.
 *  5. There is no cross-courier parcel id, so the same parcel could in principle appear in two providers: the figures are provider-reported
 *     RECORDS, not globally deduplicated parcels (`crossProviderDeduplicated` is always false).
 *  6. Nothing is ever defaulted to a fabricated rate: with no usable counts the rate is null.
 */
export type CombinedState = "valid" | "no_history" | "insufficient" | "unavailable";

export type CombinedReport = {
  state: CombinedState;
  /** Providers whose counts are included in the figures below. */
  contributing: IntelProviderKey[];
  /** Providers asked about but not included, each with the reason. */
  excluded: { provider: IntelProviderKey; why: "unsupported" | "not_configured" | "unavailable" | "percentage_only" | "incomplete_counts"; detail: string }[];
  delivered: number;
  cancelled: number;
  /** Delivered + cancelled: the parcels that count toward the rate. */
  finalOutcomes: number;
  /** Delivered / finalOutcomes x 100, one decimal; null when there are no final outcomes. */
  deliverySuccessRate: number | null;
  /** Shown, never in the rate. Null when no contributing provider reports them. */
  returned: number | null;
  failed: number | null;
  /** Parcels in a provider's total that are neither delivered nor cancelled (in progress or unclassified). Null when no provider reports a total. */
  notClassified: number | null;
  /** Sum of the totals providers reported (null when none did). Informational: not used for the rate. */
  totalReported: number | null;
  fraudReports: number | null;
  /** Rates exactly as providers reported them (display only). */
  providerRates: { provider: IntelProviderKey; deliveryRate: number | null; cancellationRate: number | null }[];
  crossProviderDeduplicated: false;
  /** Human-readable caveats (single provider, exclusions, no dedupe). */
  notes: string[];
  /** The oldest answer among contributing providers (freshness is judged on the oldest). */
  oldestCheckedAt: string | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const hasCounts = (r: ProviderReport) => (r.status === "ok" || r.status === "no_history") && r.delivered !== null && r.cancelled !== null;

export function combineReports(reports: readonly ProviderReport[]): CombinedReport {
  const contributing: ProviderReport[] = [];
  const excluded: CombinedReport["excluded"] = [];
  const providerRates: CombinedReport["providerRates"] = [];

  for (const r of reports) {
    const label = providerDescriptor(r.provider).label;
    if (r.reportedDeliveryRate !== null || r.reportedCancellationRate !== null) {
      providerRates.push({ provider: r.provider, deliveryRate: r.reportedDeliveryRate, cancellationRate: r.reportedCancellationRate });
    }
    if (hasCounts(r)) { contributing.push(r); continue; }
    if (r.status === "unsupported") excluded.push({ provider: r.provider, why: "unsupported", detail: `${label} offers no customer history lookup.` });
    else if (r.status === "not_configured") excluded.push({ provider: r.provider, why: "not_configured", detail: `${label} is not configured.` });
    else if (r.status === "unavailable") excluded.push({ provider: r.provider, why: "unavailable", detail: `${label} could not be checked (${r.reason ?? "error"}).` });
    else if ((r.status === "ok" || r.status === "no_history") && (r.delivered !== null || r.cancelled !== null)) {
      // One of the two outcome counts is missing: delivered / (delivered + cancelled) cannot be formed without inventing the other, so it stays out.
      excluded.push({ provider: r.provider, why: "incomplete_counts", detail: `${label} reported only some of the delivered / cancelled counts, so it cannot be combined.` });
    } else excluded.push({ provider: r.provider, why: "percentage_only", detail: `${label} reported a percentage without parcel counts, so it cannot be combined.` });
  }

  const sum = (pick: (r: ProviderReport) => number | null): number | null => {
    const vals = contributing.map(pick).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const delivered = sum((r) => r.delivered) ?? 0;
  const cancelled = sum((r) => r.cancelled) ?? 0;
  const finalOutcomes = delivered + cancelled;
  const withTotal = contributing.filter((r) => r.total !== null);
  const notClassified = withTotal.length ? withTotal.reduce((a, r) => a + Math.max((r.total ?? 0) - (r.delivered ?? 0) - (r.cancelled ?? 0) - (r.returned ?? 0) - (r.failed ?? 0), 0), 0) : null;
  const rate = finalOutcomes > 0 ? round1((delivered / finalOutcomes) * 100) : null;

  const state: CombinedState =
    rate !== null ? "valid"
    : contributing.length > 0 ? "no_history"
    : excluded.some((e) => e.why === "percentage_only" || e.why === "incomplete_counts") ? "insufficient"
    : "unavailable";

  const notes: string[] = [];
  if (contributing.length === 1) notes.push(`Based on ${providerDescriptor(contributing[0].provider).label} only.`);
  if (contributing.length > 1) notes.push("Counts are provider-reported records. Parcels cannot be matched across couriers, so the totals are not globally deduplicated.");
  if (state === "insufficient") notes.push("A reliable combined delivery rate cannot be calculated: the only data is percentage-only or has incomplete counts.");
  if (state === "unavailable") notes.push("No courier returned usable data, so no delivery rate can be shown.");
  if (state === "no_history") notes.push("The couriers that answered have no delivery or cancellation on record for this number.");
  const returned = sum((r) => r.returned);
  const failed = sum((r) => r.failed);
  if (returned !== null || failed !== null) notes.push("Returned and failed parcels are shown separately and are not part of the rate (their meaning differs by courier).");

  const times = contributing.map((r) => Date.parse(r.checkedAt)).filter((n) => Number.isFinite(n));
  return {
    state,
    contributing: contributing.map((r) => r.provider),
    excluded,
    delivered, cancelled, finalOutcomes,
    deliverySuccessRate: rate,
    returned, failed, notClassified, totalReported: withTotal.length ? withTotal.reduce((a, r) => a + (r.total ?? 0), 0) : null,
    fraudReports: sum((r) => r.fraudReports),
    providerRates,
    crossProviderDeduplicated: false,
    notes,
    oldestCheckedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
  };
}

/** One report per known provider, in a stable order (missing ones are reported as not_configured by the caller, never dropped silently). */
export function orderReports(reports: readonly ProviderReport[]): ProviderReport[] {
  return INTEL_PROVIDERS.map((k) => reports.find((r) => r.provider === k)).filter((r): r is ProviderReport => r !== undefined);
}
