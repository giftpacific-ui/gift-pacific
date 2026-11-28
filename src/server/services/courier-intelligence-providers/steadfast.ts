import "server-only";
import { getCourierProviderConfig, isCourierUsable } from "@/lib/courier/config";
import { requestJson, type HttpResult } from "@/lib/courier/http";
import { mapSteadfastHistoryBody } from "@/lib/courier-intelligence/steadfast-map";
import type { FailureReason, HistoryAdapter, HistoryAnswer } from "@/lib/courier-intelligence/types";

/**
 * Steadfast customer-history adapter: GET {STEADFAST_API_BASE_URL}/fraud_check/{phone}.
 *
 * CREDENTIALS: none of its own; it reuses the Steadfast courier configuration (STEADFAST_API_KEY / STEADFAST_API_SECRET / STEADFAST_API_BASE_URL,
 * STEADFAST_ENABLED=false and the https-only rule are honoured). Steadfast's published client documents ONE credential pair for every endpoint
 * (booking, status and fraud check), sent as the same `Api-Key` / `Secret-Key` headers the booking adapter uses.
 *
 * EVIDENCE: endpoint and response shape from Steadfast's own published client package README (see lib/courier-intelligence/registry.ts). The official
 * Postman page could not be opened and NO live call has ever been made: the first real check on staging is the verification.
 * (The previous adapter called /fraud_check/score/{phone} and required delivered_count / cancelled_count, which do not match that documentation.)
 *
 * Read-only GET: it can never create anything. It is NOT retried: a retry would double the checkout wait and the provider quota, and an admin can
 * simply recheck. Failures carry only a reason code (never a URL, phone, credential or provider text).
 */
const DEFAULT_BASE_URL = "https://portal.packzy.com/api/v1";
const PATH = "/fraud_check";

// The neutral contract lives in lib/courier-intelligence/types.ts; re-exported so existing imports keep working.
export type { HistoryAdapter, HistoryAnswer };

type Env = Record<string, string | undefined>;

function failureForStatus(status: number): FailureReason {
  return status === 401 || status === 403 ? "auth_failed" : status === 429 ? "rate_limited" : "error";
}

/** Pure: transport result -> answer. */
export function mapSteadfastHistoryResult(r: HttpResult): HistoryAnswer {
  switch (r.kind) {
    case "ok": return mapSteadfastHistoryBody(r.json);
    case "http_error": return { ok: false, reason: failureForStatus(r.status) };
    case "invalid_response": return { ok: false, reason: "invalid_response" };
    case "network": return { ok: false, reason: /in time/i.test(r.message) ? "timeout" : "error" };
  }
}

/** Null (not configured) unless the Steadfast courier credentials are complete, enabled and valid. `deps` is for tests only. */
export function createSteadfastHistoryAdapter(deps: { env?: Env; request?: typeof requestJson } = {}): HistoryAdapter | null {
  const courier = getCourierProviderConfig("steadfast", deps.env ?? process.env);
  if (!isCourierUsable(courier) || !courier.apiKey || !courier.apiSecret) return null;
  const base = (courier.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const headers = { "Api-Key": courier.apiKey, "Secret-Key": courier.apiSecret };
  const request = deps.request ?? requestJson;
  return {
    key: "steadfast",
    async lookup(phone, timeoutMs) {
      // The service already normalised the phone; this keeps anything unexpected out of the URL.
      if (!/^01[3-9]\d{8}$/.test(phone)) return { ok: false, reason: "invalid_phone" };
      return mapSteadfastHistoryResult(await request(`${base}${PATH}/${encodeURIComponent(phone)}`, { method: "GET", headers }, timeoutMs));
    },
  };
}
