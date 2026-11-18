import "server-only";
import { GA4_ID_PATTERN } from "@/lib/analytics/ids";
import { purchaseEvent, type PurchaseInput } from "@/lib/analytics/payloads";
import { redactSensitive } from "@/lib/analytics/server-events";

/**
 * GA4 Measurement Protocol client (server-side `purchase`). Sibling of the Meta CAPI client in server-events.ts, same guarantees:
 *  - never throws: every failure becomes `{ ok: false }` so tracking cannot break an order operation;
 *  - bounded by a timeout; failures are classified retryable / permanent;
 *  - the API secret lives in the QUERY STRING of this endpoint (Google's design), so it is redacted from every message returned
 *    and is never logged, stored or sent to the browser (it is read only from the server-only GA4_API_SECRET).
 *
 * The purchase params are built by the SAME `purchaseEvent()` the browser uses, so the two can never drift apart.
 * Delivery policy: when this is configured the SERVER is the only sender of the GA4 purchase (the browser skips it), because the
 * Measurement Protocol docs describe no de-duplication between browser and server events.
 */

export const GA4_MP_TIMEOUT_MS = 5_000;

type Env = Record<string, string | undefined>;

export type Ga4Config = { measurementId: string; apiSecret: string; debug: boolean };
export type Ga4ConfigResult = { ok: true; config: Ga4Config } | { ok: false; reason: "no_measurement_id" | "invalid_measurement_id" | "no_secret" };

/**
 * Measurement id for the server events: `GA4_MEASUREMENT_ID` if set, otherwise the Google id already configured for the storefront
 * when that is a GA4 (G-…) id. A store that loads GA4 through a GTM container must set GA4_MEASUREMENT_ID (a GTM id is not one).
 * The measurement id is public (it is in the page source); only the API secret is secret.
 */
export function resolveGa4MeasurementId(settingsGoogleId: string | null | undefined, env: Env = process.env): { ok: true; id: string } | { ok: false; reason: "no_measurement_id" | "invalid_measurement_id" } {
  const explicit = env.GA4_MEASUREMENT_ID?.trim();
  if (explicit) {
    const id = explicit.toUpperCase();
    return GA4_ID_PATTERN.test(id) ? { ok: true, id } : { ok: false, reason: "invalid_measurement_id" };
  }
  const fromStorefront = (settingsGoogleId || env.NEXT_PUBLIC_GTM_ID || "").trim().toUpperCase();
  return GA4_ID_PATTERN.test(fromStorefront) ? { ok: true, id: fromStorefront } : { ok: false, reason: "no_measurement_id" };
}

export function resolveGa4Config(settingsGoogleId: string | null | undefined, env: Env = process.env): Ga4ConfigResult {
  const m = resolveGa4MeasurementId(settingsGoogleId, env);
  if (!m.ok) return m;
  const apiSecret = env.GA4_API_SECRET?.trim();
  if (!apiSecret) return { ok: false, reason: "no_secret" };
  return { ok: true, config: { measurementId: m.id, apiSecret, debug: env.GA4_MP_DEBUG?.trim().toLowerCase() === "true" } };
}

export type Ga4Payload = {
  client_id: string;
  /** When the order was confirmed (GA4 accepts at most 72 hours back). */
  timestamp_micros: number;
  events: { name: "purchase"; params: Record<string, unknown> }[];
};

export function buildGa4PurchasePayload(args: { order: PurchaseInput; eventId: string; clientId: string; sessionId?: string | null; eventTime: Date }): Ga4Payload {
  const ga4 = purchaseEvent(args.order, args.eventId).ga4!;
  return {
    client_id: args.clientId,
    timestamp_micros: args.eventTime.getTime() * 1000,
    events: [
      {
        name: "purchase",
        params: {
          ...ga4.params,
          // Ties the purchase to the visitor's original session when we have it, and makes it count as engaged activity.
          ...(args.sessionId ? { session_id: args.sessionId } : {}),
          engagement_time_msec: 1,
        },
      },
    ],
  };
}

export type Ga4SendResult =
  | { ok: true; httpStatus: number; /** debug endpoint: validated, NOT recorded by GA4 */ debugOnly?: boolean }
  | { ok: false; retryable: boolean; httpStatus?: number; code?: string; message: string };

type ValidationBody = { validationMessages?: { fieldPath?: string; description?: string; validationCode?: string }[] };

/**
 * POSTs one payload. With GA4_MP_DEBUG=true it goes to Google's VALIDATION endpoint instead, which reports problems the real endpoint
 * silently ignores (the real one answers 2xx even for malformed events) but does NOT record the event; the caller must not treat that
 * as delivered (`debugOnly`).
 */
export async function sendGa4Purchase(config: Ga4Config, payload: Ga4Payload, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<Ga4SendResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? GA4_MP_TIMEOUT_MS);
  const url = `https://www.google-analytics.com/${config.debug ? "debug/" : ""}mp/collect?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`;
  try {
    const res = await doFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify(payload) });
    if (!res.ok) {
      return {
        ok: false,
        retryable: res.status === 429 || res.status >= 500,
        httpStatus: res.status,
        code: String(res.status),
        message: redactSensitive(`GA4 responded with HTTP ${res.status}.`, [config.apiSecret]),
      };
    }
    if (config.debug) {
      let body: ValidationBody | null = null;
      try {
        body = (await res.json()) as ValidationBody;
      } catch {
        body = null;
      }
      const problems = body?.validationMessages ?? [];
      if (problems.length > 0) {
        const text = problems.map((p) => `${p.fieldPath ?? "?"}: ${p.description ?? p.validationCode ?? "invalid"}`).join("; ");
        return { ok: false, retryable: false, httpStatus: res.status, code: "validation", message: redactSensitive(text, [config.apiSecret]) };
      }
      return { ok: true, httpStatus: res.status, debugOnly: true };
    }
    return { ok: true, httpStatus: res.status };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      retryable: true,
      code: aborted ? "timeout" : "network",
      message: aborted ? `No response from GA4 within ${(options.timeoutMs ?? GA4_MP_TIMEOUT_MS) / 1000}s.` : "Could not reach GA4.",
    };
  } finally {
    clearTimeout(timer);
  }
}
