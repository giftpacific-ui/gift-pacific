import type { HistoryMetrics, MetricName, ProviderDescriptor } from "@/lib/courier-intelligence/types";

/**
 * The verification gate: the ONLY way an adapter's answer becomes a stored, combinable report. Pure.
 *
 *  1. A metric the courier's descriptor does not list as supported is REMOVED (set to null), never trusted: a number the courier is not documented
 *     to report is a number someone made up or mis-mapped. The removed names are returned so the service can flag the drift.
 *  2. Every remaining value must be plausible: counts are whole numbers from 0 to 100 million, rates are 0 to 100, fraud reports 0 to 1000.
 *  3. The answer must not contradict itself: the total cannot be smaller than delivered + cancelled, and "empty" cannot coexist with parcels.
 *  4. An answer that carries no metric at all is not a report (it would otherwise be mistaken for "no history").
 * Anything that fails is `invalid_response`: an unusable answer, never zero and never evidence about the customer.
 */
export type VerifyResult =
  | { ok: true; metrics: HistoryMetrics; stripped: MetricName[] }
  | { ok: false; why: string };

const FIELD: Record<MetricName, keyof HistoryMetrics> = {
  delivered: "delivered", cancelled: "cancelled", returned: "returned", failed: "failed", total: "total",
  deliveryRate: "reportedDeliveryRate", cancellationRate: "reportedCancellationRate", fraudReports: "fraudReports",
};
const COUNTS: MetricName[] = ["delivered", "cancelled", "returned", "failed", "total"];
const MAX_COUNT = 100_000_000;
const MAX_FRAUD_REPORTS = 1000;

const isWhole = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const isPercent = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

export function verifyHistoryMetrics(descriptor: Pick<ProviderDescriptor, "supportedMetrics">, input: HistoryMetrics): VerifyResult {
  const supported = new Set<MetricName>(descriptor.supportedMetrics);
  const m: HistoryMetrics = { ...input };
  const stripped: MetricName[] = [];

  for (const name of Object.keys(FIELD) as MetricName[]) {
    const key = FIELD[name];
    if (m[key] !== null && m[key] !== undefined && !supported.has(name)) {
      (m as Record<string, unknown>)[key] = null;
      stripped.push(name);
    } else if (m[key] === undefined) {
      (m as Record<string, unknown>)[key] = null;
    }
  }

  for (const name of COUNTS) {
    const v = m[FIELD[name]];
    if (v !== null && !isWhole(v, MAX_COUNT)) return { ok: false, why: `${name} is not a plausible count` };
  }
  if (m.fraudReports !== null && !isWhole(m.fraudReports, MAX_FRAUD_REPORTS)) return { ok: false, why: "fraudReports is not a plausible count" };
  for (const key of ["reportedDeliveryRate", "reportedCancellationRate"] as const) {
    if (m[key] !== null && !isPercent(m[key])) return { ok: false, why: `${key} is not a percentage` };
  }

  if (m.total !== null && m.total < (m.delivered ?? 0) + (m.cancelled ?? 0)) return { ok: false, why: "total is smaller than delivered plus cancelled" };
  const anyParcels = COUNTS.some((n) => (m[FIELD[n]] as number | null) !== null && (m[FIELD[n]] as number) > 0);
  if (m.empty && anyParcels) return { ok: false, why: "the answer says no history but lists parcels" };

  const carriesMetric = (Object.keys(FIELD) as MetricName[]).some((n) => m[FIELD[n]] !== null);
  if (!carriesMetric) return { ok: false, why: "the answer carries no metric" };
  return { ok: true, metrics: m, stripped };
}
