import { EMPTY_METRICS, type FailureReason, type ProviderReport } from "@/lib/courier-intelligence/types";

/**
 * Pure mapper for Steadfast's GET /fraud_check/{phone} answer.
 *
 * DOCUMENTED SHAPE (Steadfast's published client README): { total_parcels, total_delivered, total_cancelled, total_fraud_reports: [] }.
 * Strict: the three counts must be whole non-negative numbers, and the total cannot be smaller than delivered + cancelled. Anything else is an
 * unusable answer (never a guess). `total_fraud_reports` is a list whose items are undocumented: only its LENGTH is kept; the items are never
 * read, stored or shown (they may identify other merchants).
 * Steadfast reports no returned/failed count, no rate and no score, so those stay null; a rate is never derived here.
 */
export type SteadfastMapResult = { ok: true; metrics: Omit<ProviderReport, "provider" | "status" | "reason" | "checkedAt" | "cached"> & { empty: boolean } } | { ok: false; reason: FailureReason };

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000_000;
const MAX_REPORTS = 1000;

export function mapSteadfastHistoryBody(json: unknown): SteadfastMapResult {
  const body = asRecord(json);
  if (!body) return { ok: false, reason: "invalid_response" };
  // Some Steadfast endpoints repeat an HTTP-like status in the body; anything but 200 is a failure, never a result.
  if (typeof body.status === "number" && body.status !== 200) {
    return { ok: false, reason: body.status === 401 || body.status === 403 ? "auth_failed" : body.status === 429 ? "rate_limited" : "error" };
  }
  const total = body.total_parcels;
  const delivered = body.total_delivered;
  const cancelled = body.total_cancelled;
  if (!isCount(total) || !isCount(delivered) || !isCount(cancelled)) return { ok: false, reason: "invalid_response" };
  if (total < delivered + cancelled) return { ok: false, reason: "invalid_response" }; // contradictory
  const reports = Array.isArray(body.total_fraud_reports) ? Math.min(body.total_fraud_reports.length, MAX_REPORTS) : null;
  return {
    ok: true,
    metrics: { ...EMPTY_METRICS, delivered, cancelled, total, fraudReports: reports, empty: total === 0 && delivered === 0 && cancelled === 0 },
  };
}
