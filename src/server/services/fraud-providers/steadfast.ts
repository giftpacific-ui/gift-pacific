import "server-only";
import { getCourierProviderConfig, isCourierUsable } from "@/lib/courier/config";
import { requestJson, type HttpResult } from "@/lib/courier/http";
import { normalizeBdPhone, type FraudCheckHistory } from "@/lib/advance-policy";
import { FraudCheckProviderError, type FraudProviderFailure } from "@/lib/fraud-check";
import type { FraudCheckConfig, FraudCheckProvider } from "@/server/services/fraud-check.service";

/**
 * Steadfast fraud-check adapter: GET {STEADFAST_API_BASE_URL}/fraud_check/score/{phone}.
 *
 * CREDENTIALS: none of its own. It reuses the Steadfast courier configuration (`getCourierProviderConfig("steadfast")`): STEADFAST_API_KEY,
 * STEADFAST_API_SECRET, STEADFAST_API_BASE_URL (default https://portal.packzy.com/api/v1), and honours STEADFAST_ENABLED=false and the https-only rule.
 * Authentication is the same pair of headers the courier adapter sends: `Api-Key` and `Secret-Key`. FRAUD_CHECK_API_KEY / FRAUD_CHECK_API_BASE_URL
 * are NOT used by this adapter.
 *
 * WHAT IS MAPPED (strictly): the exact integer fields `delivered_count` and `cancelled_count`, as delivered / cancelled parcels. Nothing else feeds the
 * score. In particular it NEVER estimates a count from `delivery_ratio`, `cancellation_ratio`, `volume_band` or `volume_range`, and it does not
 * interpret any parcel status. If the answer has no counts the result is `no_counts` (fallback policy), not a guess. `volume_range` is a band such
 * as "50+", not a total, so `total` is left unset.
 *
 * VERIFICATION STATUS: the endpoint, the two headers and the count field names come from the task description and from third-party descriptions of the
 * response; the official guide's complete response schema has NOT been checked against this file inside this repository. Everything provider-specific
 * lives here, so correcting a field name is a one-file change. No live call has ever been made.
 *
 * Failures carry only a reason code (never a URL, phone number, credential or provider text), so nothing sensitive can reach a log.
 */
const DEFAULT_BASE_URL = "https://portal.packzy.com/api/v1"; // same default as the Steadfast courier adapter
const FRAUD_SCORE_PATH = "/fraud_check/score";

type Env = Record<string, string | undefined>;

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const isAbsent = (v: unknown) => v === undefined || v === null;

/** HTTP status (or a status repeated inside the body) -> why there is no usable answer. */
function failureForStatus(status: number): FraudProviderFailure {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  return "error";
}

/** Pure: a parsed 200 body -> counts, or a typed failure. `phone` is the normalised number that was asked about. */
export function mapSteadfastFraudBody(json: unknown, phone: string): FraudCheckHistory {
  const body = asRecord(json);
  if (!body) throw new FraudCheckProviderError("invalid_response");

  // Some Steadfast endpoints repeat an HTTP-like status inside the body. Anything other than 200 is a failure, never a result.
  if (typeof body.status === "number" && body.status !== 200) throw new FraudCheckProviderError(failureForStatus(body.status));

  // If the answer says which number it is about and that is a different number, it is not an answer to our question.
  if (typeof body.phone === "string") {
    const echoed = normalizeBdPhone(body.phone);
    if (echoed !== null && echoed !== phone) throw new FraudCheckProviderError("invalid_response");
  }

  const delivered = body.delivered_count;
  const cancelled = body.cancelled_count;
  if (isAbsent(delivered) || isAbsent(cancelled)) throw new FraudCheckProviderError("no_counts"); // percentages/bands alone cannot be turned into counts
  if (!isCount(delivered) || !isCount(cancelled)) throw new FraudCheckProviderError("invalid_response"); // present but not a whole non-negative number
  return { delivered, cancelled };
}

/** Pure: the transport result -> counts, or a typed failure. */
export function mapSteadfastFraudResult(result: HttpResult, phone: string): FraudCheckHistory {
  switch (result.kind) {
    case "ok":
      return mapSteadfastFraudBody(result.json, phone);
    case "http_error":
      throw new FraudCheckProviderError(failureForStatus(result.status));
    case "invalid_response":
      throw new FraudCheckProviderError("invalid_response");
    case "network":
      throw new FraudCheckProviderError(/in time/i.test(result.message) ? "timeout" : "error");
  }
}

/**
 * Registered as `steadfast` in the fraud-check registry. Returns null (provider unavailable, fallback policy) unless the Steadfast courier
 * credentials are complete, enabled and valid. `deps` exists for tests only.
 */
export function createSteadfastFraudProvider(config: FraudCheckConfig, deps: { env?: Env; request?: typeof requestJson } = {}): FraudCheckProvider | null {
  const courier = getCourierProviderConfig("steadfast", deps.env ?? process.env);
  if (!isCourierUsable(courier) || !courier.apiKey || !courier.apiSecret) return null;

  const base = (courier.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const headers = { "Api-Key": courier.apiKey, "Secret-Key": courier.apiSecret };
  const request = deps.request ?? requestJson;

  return {
    key: "steadfast",
    async check(phone) {
      // The service already normalised the phone; this keeps anything unexpected out of the URL.
      if (!/^01[3-9]\d{8}$/.test(phone)) throw new FraudCheckProviderError("error");
      const result = await request(`${base}${FRAUD_SCORE_PATH}/${encodeURIComponent(phone)}`, { method: "GET", headers }, config.timeoutMs);
      return mapSteadfastFraudResult(result, phone);
    },
  };
}
