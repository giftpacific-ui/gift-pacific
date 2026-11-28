/**
 * Steadfast Courier adapter (merchant API v1).
 *
 * EVIDENCE LEVEL (read this before trusting any line below):
 *  - Base URL, paths, headers, request fields, response shape, the 11-value delivery-status vocabulary and the webhook
 *    fields (consignment_id, invoice, status, cod_amount, updated_at, Bearer-token auth) were checked against the client
 *    package PUBLISHED BY STEADFAST ITSELF (packagist steadfast-courier/steadfast-laravel-package v2.0.0, author
 *    it.woop@steadfast.com.bd, repo steadfast-it/SteadFast-Laravel-Package). That README states it covers every endpoint of the
 *    official Postman documentation and links it. The Postman page itself could NOT be opened from the build environment, so
 *    this is vendor-published secondary evidence, not a read of the primary document.
 *  - GET /status_by_invoice/{invoice} is described by that README as "not listed in the current Postman collection, but still
 *    served". It is therefore used ONLY for uncertain-booking recovery, ONLY when STEADFAST_INVOICE_LOOKUP=true, and only a
 *    positive answer is ever acted upon (absence is never inferred: its not-found reply shape is undocumented).
 *  - NOT verified / deliberately not implemented: a per-consignment payout/remittance feed, a cancel-consignment endpoint, any
 *    "picked up / in transit / out for delivery" status (the verified vocabulary has none), a tracking URL, webhook HMAC
 *    signatures (the documented scheme is a static bearer token), rate limits, whether cod_amount accepts decimals.
 *  - Nothing here has been run against the live API (Steadfast publishes no sandbox). Run one real test booking first.
 * Everything provider-specific stays in this file so a correction is a one-file change.
 */
import { requestJson, type HttpResult } from "@/lib/courier/http";
import { sanitizeProviderMessage } from "@/lib/courier/status";
import type { CourierConfig } from "@/lib/courier/config";
import { logServerInfo } from "@/lib/logger";
import type {
  CourierBookingRequest,
  CourierBookingResult,
  CourierConnectionResult,
  CourierEvent,
  CourierLookupResult,
  CourierProvider,
  CourierStatusResult,
  ParsedWebhook,
  WebhookInspection,
} from "@/lib/courier/types";

const DEFAULT_BASE_URL = "https://portal.packzy.com/api/v1";
const CREATE_ORDER_PATH = "/create_order";
const STATUS_BY_CID_PATH = "/status_by_cid/";
const STATUS_BY_INVOICE_PATH = "/status_by_invoice/";
const BALANCE_PATH = "/get_balance";

/** The documented delivery-status vocabulary. Anything else is kept raw and treated as UNKNOWN (never guessed). */
export const STEADFAST_STATUSES = [
  "in_review", "pending", "hold",
  "delivered_approval_pending", "partial_delivered_approval_pending", "cancelled_approval_pending", "unknown_approval_pending",
  "delivered", "partial_delivered", "cancelled", "unknown",
] as const;

const STATUS_MAP: Record<string, CourierEvent> = {
  in_review: "PENDING",
  pending: "PENDING",
  hold: "PENDING",
  delivered_approval_pending: "DELIVERED",
  delivered: "DELIVERED",
  // A partial delivery must never complete the whole order (items and cash are only partly settled): an admin reviews it.
  partial_delivered_approval_pending: "PARTIAL_DELIVERED",
  partial_delivered: "PARTIAL_DELIVERED",
  cancelled_approval_pending: "CANCELLED",
  cancelled: "CANCELLED",
  unknown_approval_pending: "UNKNOWN",
  unknown: "UNKNOWN",
};

/**
 * Progress rank, used only to stop a lower/older status overwriting a higher one when no provider timestamp exists.
 * null = cannot be ranked (never overrides a ranked status). *_approval_pending = outcome recorded, awaiting Steadfast admin approval.
 */
const STATUS_RANK: Record<string, number | null> = {
  in_review: 0, pending: 1, hold: 1,
  delivered_approval_pending: 2, partial_delivered_approval_pending: 2, cancelled_approval_pending: 2,
  delivered: 3, partial_delivered: 3, cancelled: 3,
  unknown: null, unknown_approval_pending: null,
};
const FINAL = new Set(["delivered", "partial_delivered", "cancelled"]);

// Credential-free vocabulary helpers (also exposed through the adapter and lib/courier/index.ts statusMapperFor).
export const mapSteadfastStatus = (raw: string): CourierEvent => STATUS_MAP[raw.toLowerCase()] ?? "UNKNOWN";
export const steadfastStatusRank = (raw: string): number | null => {
  const r = STATUS_RANK[raw.toLowerCase()];
  return r === undefined ? null : r;
};
export const isSteadfastFinal = (raw: string): boolean => FINAL.has(raw.toLowerCase());

/**
 * HTTP statuses in the 4xx range that do NOT prove "nothing was created":
 *  408 Request Timeout - the server gave up waiting; the request may still have been processed.
 *  409 Conflict        - the request clashed with existing state (typically "a parcel for this invoice already exists").
 * Treating either as a clean rejection would mark the order FAILED (one-click retry) and invite a second parcel, so both are UNCERTAIN.
 * Every other 4xx (validation, auth, 429 "not processed") stays a definite refusal.
 */
export const STEADFAST_AMBIGUOUS_STATUSES: readonly number[] = [408, 409];
export const isSteadfastDefiniteRefusal = (status: number): boolean => status >= 400 && status < 500 && !STEADFAST_AMBIGUOUS_STATUSES.includes(status);

type Request = typeof requestJson;
type LogFn = (action: string, outcome: string, extra: Record<string, string | number | boolean | null>) => void;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const asText = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
const asAmount = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? n : null;
};
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
/** Only an unambiguous (zone-carrying) instant is trusted; a zone-less "2026-03-21 07:05:31" is dropped rather than guessed. */
export function parseProviderInstant(v: unknown, now: Date = new Date()): Date | null {
  if (typeof v !== "string" || !HAS_ZONE.test(v.trim())) return null;
  const d = new Date(v.trim());
  if (Number.isNaN(d.getTime())) return null;
  // A time well in the future would freeze every later (real) update behind it.
  return d.getTime() > now.getTime() + 10 * 60 * 1000 ? null : d;
}

const LOCAL_PHONE = /^01[3-9]\d{8}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9._\-]{1,64}$/;

export function createSteadfastProvider(cfg: CourierConfig, request: Request = requestJson, log?: LogFn): CourierProvider {
  const base = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    "Api-Key": cfg.apiKey ?? "",
    "Secret-Key": cfg.apiSecret ?? "",
  };
  const secrets = [cfg.apiKey, cfg.apiSecret];
  const clean = (t: string) => sanitizeProviderMessage(t, secrets);
  // Safe request log: provider, action, outcome, HTTP status, duration and (for booking/lookup) OUR order number. Never headers, bodies,
  // names, phones, addresses or any secret.
  const emit: LogFn = log ?? ((action, outcome, extra) => logServerInfo("courier.steadfast", `${action} ${outcome}`, extra));
  async function call(action: string, reference: string | null, url: string, init: Parameters<Request>[1]): Promise<HttpResult> {
    const started = Date.now();
    const result = await request(url, init, cfg.timeoutMs);
    emit(action, result.kind, {
      provider: "steadfast", action, outcome: result.kind,
      httpStatus: result.kind === "ok" || result.kind === "http_error" || result.kind === "invalid_response" ? result.status : null,
      durationMs: Date.now() - started, ...(reference ? { reference } : {}),
    });
    return result;
  }

  return {
    key: "steadfast",
    displayName: "Steadfast",
    features: { webhook: true, statusPolling: true, connectionCheck: true, referenceLookup: cfg.invoiceLookup },

    async book(req: CourierBookingRequest): Promise<CourierBookingResult> {
      // Defence in depth: refuse locally (nothing is sent) what the provider would certainly refuse.
      if (!req.reference.trim()) return { ok: false, kind: "rejected", message: "The order has no reference to send to the courier." };
      if (!LOCAL_PHONE.test(req.recipientPhone)) return { ok: false, kind: "rejected", message: "The recipient phone is not a valid Bangladeshi mobile number." };
      if (!req.recipientName.trim() || !req.recipientAddress.trim()) return { ok: false, kind: "rejected", message: "The recipient name and address are required." };
      if (!Number.isFinite(req.codAmount) || req.codAmount < 0) return { ok: false, kind: "rejected", message: "The cash-on-delivery amount is invalid." };

      // NEVER retried: a timed-out create_order may still have been accepted, and the API has no idempotency key.
      const result: HttpResult = await call("create_order", req.reference, `${base}${CREATE_ORDER_PATH}`, {
        method: "POST",
        headers,
        body: {
          invoice: req.reference,
          recipient_name: req.recipientName,
          recipient_phone: req.recipientPhone,
          recipient_address: req.recipientAddress,
          cod_amount: req.codAmount,
          ...(req.note ? { note: req.note } : {}),
          ...(req.itemDescription ? { item_description: req.itemDescription } : {}),
        },
      });

      if (result.kind === "network") return { ok: false, kind: "uncertain", message: clean(result.message) };
      if (result.kind === "invalid_response") {
        return { ok: false, kind: "uncertain", message: "The courier sent an unreadable response." };
      }
      if (result.kind === "http_error") {
        const body = asRecord(result.json);
        const provided = asText(body?.message);
        // A definite 4xx = the request itself was refused → nothing was created. 5xx, 408 and 409 = unknown (see STEADFAST_AMBIGUOUS_STATUSES).
        if (isSteadfastDefiniteRefusal(result.status)) {
          return { ok: false, kind: "rejected", message: clean(provided ?? `The courier rejected the request (HTTP ${result.status}).`) };
        }
        const why =
          result.status === 408 ? "The courier timed out (HTTP 408)"
          : result.status === 409 ? "The courier reported a conflict (HTTP 409): a parcel may already exist for this order"
          : `The courier answered with HTTP ${result.status}`;
        return { ok: false, kind: "uncertain", message: clean(provided ? `${why}: ${provided}` : `${why}.`) };
      }

      const body = asRecord(result.json);
      const consignment = asRecord(body?.consignment);
      const consignmentId = asText(consignment?.consignment_id);
      if (body?.status === 200 && consignmentId) {
        // A reply that names a DIFFERENT invoice than the one we sent cannot be trusted to be ours: settle it by hand.
        const echoed = asText(consignment?.invoice);
        if (echoed !== null && echoed !== req.reference) {
          return { ok: false, kind: "uncertain", message: "The courier's reply referred to a different order reference." };
        }
        const echoedCod = asAmount(consignment?.cod_amount);
        return {
          ok: true,
          consignmentId,
          trackingCode: asText(consignment?.tracking_code),
          trackingUrl: null, // no tracking URL is documented; built from the store's own template if one is configured
          providerStatus: asText(consignment?.status),
          ...(echoedCod !== null ? { codAmount: echoedCod } : {}),
        };
      }
      // A 2xx whose body doesn't say "created": could be a soft rejection or a
      // shape we don't understand. Don't guess — flag it for manual checking.
      return {
        ok: false,
        // The same rule as for a real HTTP status: only a definite refusal is "rejected" (a body that says 408/409 is just as ambiguous).
        kind: typeof body?.status === "number" && isSteadfastDefiniteRefusal(body.status) ? "rejected" : "uncertain",
        message: clean(asText(body?.message) ?? "The courier's reply did not confirm the booking."),
      };
    },

    async fetchStatus(consignmentId: string): Promise<CourierStatusResult> {
      // Read-only → one automatic retry on a network failure or a 5xx is safe.
      const url = `${base}${STATUS_BY_CID_PATH}${encodeURIComponent(consignmentId)}`;
      let result = await call("status_by_cid", null, url, { method: "GET", headers });
      if (result.kind === "network" || (result.kind === "http_error" && result.status >= 500)) {
        result = await call("status_by_cid", null, url, { method: "GET", headers });
      }
      if (result.kind !== "ok") return { ok: false, message: "Could not read the courier status right now." };
      const status = asText(asRecord(result.json)?.delivery_status);
      return status ? { ok: true, status } : { ok: false, message: "The courier's status reply was not understood." };
    },

    async checkConnection(): Promise<CourierConnectionResult> {
      // GET /get_balance is read-only. Only "the credentials were accepted" is reported: the balance itself is never read out.
      let result = await call("get_balance", null, `${base}${BALANCE_PATH}`, { method: "GET", headers });
      if (result.kind === "network") result = await call("get_balance", null, `${base}${BALANCE_PATH}`, { method: "GET", headers });
      if (result.kind === "network") return { ok: false, kind: "unreachable", message: clean(result.message) };
      if (result.kind === "http_error") {
        return result.status === 401 || result.status === 403
          ? { ok: false, kind: "auth", message: "Steadfast refused the API key / secret." }
          : { ok: false, kind: "unexpected", message: `Steadfast answered with HTTP ${result.status}.` };
      }
      if (result.kind === "invalid_response") return { ok: false, kind: "unexpected", message: "Steadfast sent an unreadable response." };
      const body = asRecord(result.json);
      if (body && (body.status === 401 || body.status === 403)) return { ok: false, kind: "auth", message: "Steadfast refused the API key / secret." };
      if (body && (body.status === 200 || typeof body.current_balance === "number")) return { ok: true };
      return { ok: false, kind: "unexpected", message: "Steadfast's reply was not the expected shape." };
    },

    async lookupByReference(reference: string): Promise<CourierLookupResult> {
      if (!cfg.invoiceLookup) return { kind: "unknown", message: "Reference lookup is not enabled (STEADFAST_INVOICE_LOOKUP)." };
      if (!SAFE_REFERENCE.test(reference)) return { kind: "unknown", message: "The order reference cannot be looked up." };
      const url = `${base}${STATUS_BY_INVOICE_PATH}${encodeURIComponent(reference)}`;
      let result = await call("status_by_invoice", reference, url, { method: "GET", headers });
      if (result.kind === "network" || (result.kind === "http_error" && result.status >= 500)) {
        result = await call("status_by_invoice", reference, url, { method: "GET", headers });
      }
      if (result.kind !== "ok") return { kind: "unknown", message: "The courier could not confirm either way." };
      const body = asRecord(result.json);
      const status = asText(body?.delivery_status);
      // Only a positive, well-formed answer counts as "a parcel exists". Everything else stays unknown, never "absent".
      return body?.status === 200 && status ? { kind: "found", status } : { kind: "unknown", message: "The courier could not confirm either way." };
    },

    parseWebhook(body: unknown): ParsedWebhook | null {
      const r = inspect(body);
      return r.kind === "event" ? r.event : null;
    },

    inspectWebhook(body: unknown, now?: Date): WebhookInspection {
      return inspect(body, now);
    },

    mapStatus: mapSteadfastStatus,
    statusRank: steadfastStatusRank,
    isFinalStatus: isSteadfastFinal,
  };
}

function inspect(body: unknown, now: Date = new Date()): WebhookInspection {
  const b = asRecord(body);
  if (!b) return { kind: "malformed", reason: "not an object" };
  // Only delivery-status notifications drive order updates (payout / tracking-progress notices are acknowledged and ignored).
  if (b.notification_type !== undefined && b.notification_type !== "delivery_status") return { kind: "ignored" };
  const status = asText(b.status);
  if (!status) return { kind: "malformed", reason: "missing status" };
  if (status.length > 64) return { kind: "malformed", reason: "status too long" };
  const consignmentId = asText(b.consignment_id);
  const reference = asText(b.invoice);
  if (!consignmentId && !reference) return { kind: "malformed", reason: "no consignment_id or invoice" };
  if (consignmentId && consignmentId.length > 64) return { kind: "malformed", reason: "consignment_id too long" };
  if (reference && reference.length > 100) return { kind: "malformed", reason: "invoice too long" };
  const providerEventAt = parseProviderInstant(b.updated_at, now);
  const codAmount = asAmount(b.cod_amount);
  return {
    kind: "event",
    event: {
      consignmentId, reference, status: status.toLowerCase(),
      ...(providerEventAt ? { providerEventAt } : {}),
      ...(codAmount !== null ? { codAmount } : {}),
    },
  };
}
