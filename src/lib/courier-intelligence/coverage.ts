import { INTEL_PROVIDERS, type IntelProviderKey, type MetricName, type ProviderDescriptor, type ProviderReport } from "@/lib/courier-intelligence/types";
import { providerDescriptor } from "@/lib/courier-intelligence/registry";

/**
 * Which couriers report which metric, and for every courier that does NOT, why not. This is how "unsupported" is said out loud instead of being
 * shown as a zero: a metric nobody reports stays "not reported", and each gap names its cause.
 *
 *  unsupported_by_courier  the courier offers no such figure (or no history lookup at all): it can never be filled in
 *  no_answer               the courier could have reported it but gave no usable answer this time (not configured / failed): the value is UNKNOWN, not zero
 *  not_in_answer           the courier answered but left this figure out
 */
export type MissingWhy = "unsupported_by_courier" | "no_answer" | "not_in_answer";
export type MetricCoverage = { metric: MetricName; reportedBy: IntelProviderKey[]; missing: { provider: IntelProviderKey; why: MissingWhy }[] };

export const METRIC_ORDER: readonly MetricName[] = ["delivered", "cancelled", "returned", "failed", "total", "deliveryRate", "cancellationRate", "fraudReports"];
export const METRIC_LABEL: Record<MetricName, string> = {
  delivered: "Delivered", cancelled: "Cancelled", returned: "Returned", failed: "Failed", total: "Total parcels",
  deliveryRate: "Delivery rate", cancellationRate: "Cancellation rate", fraudReports: "Fraud reports",
};

const value = (r: ProviderReport, m: MetricName): number | null =>
  m === "deliveryRate" ? r.reportedDeliveryRate : m === "cancellationRate" ? r.reportedCancellationRate : (r[m] as number | null);

export function describeMetricCoverage(
  reports: readonly ProviderReport[],
  descriptorOf: (k: IntelProviderKey) => Pick<ProviderDescriptor, "capability" | "supportedMetrics"> = providerDescriptor,
): MetricCoverage[] {
  return METRIC_ORDER.map((metric) => {
    const reportedBy: IntelProviderKey[] = [];
    const missing: MetricCoverage["missing"] = [];
    for (const provider of INTEL_PROVIDERS) {
      const d = descriptorOf(provider);
      const r = reports.find((x) => x.provider === provider);
      if (d.capability !== "supported" || !d.supportedMetrics.includes(metric)) { missing.push({ provider, why: "unsupported_by_courier" }); continue; }
      if (!r || (r.status !== "ok" && r.status !== "no_history")) { missing.push({ provider, why: "no_answer" }); continue; }
      if (value(r, metric) === null) { missing.push({ provider, why: "not_in_answer" }); continue; }
      reportedBy.push(provider);
    }
    return { metric, reportedBy, missing };
  });
}

/** Metrics that NO courier in this report supplies, with the metric's label: what an admin should read as "not available", never as zero. */
export const unreportedMetrics = (coverage: readonly MetricCoverage[]): MetricCoverage[] => coverage.filter((c) => c.reportedBy.length === 0);
