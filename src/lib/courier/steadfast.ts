/**
 * Steadfast Courier adapter.
 *
 * ⚠ UNVERIFIED AGAINST THE LIVE API. The endpoint paths, header names, body
 * fields, response shape and status vocabulary below are written from the
 * publicly documented Steadfast merchant API as the author recalled it, with
 * NO network access and NO credentials to test against. Before enabling in
 * production: compare every item here with Steadfast's current documentation
 * and run one real test booking. Everything provider-specific is isolated in
 * this file (and the constants below) so a correction is a one-file change.
 * Without COURIER_PROVIDER=steadfast + credentials this adapter is never used.
 */
import { requestJson, type HttpResult } from "@/lib/courier/http";
import { sanitizeProviderMessage } from "@/lib/courier/status";
import type { CourierConfig } from "@/lib/courier/config";
import type {
  CourierBookingRequest,
  CourierBookingResult,
  CourierEvent,
  CourierProvider,
  CourierStatusResult,
  ParsedWebhook,
} from "@/lib/courier/types";

const DEFAULT_BASE_URL = "https://portal.packzy.com/api/v1";
const CREATE_ORDER_PATH = "/create_order";
const STATUS_BY_CID_PATH = "/status_by_cid/";

const STATUS_MAP: Record<string, CourierEvent> = {
  pending: "PENDING",
  in_review: "PENDING",
  hold: "PENDING",
  delivered_approval_pending: "DELIVERED",
  delivered: "DELIVERED",
  partial_delivered_approval_pending: "DELIVERED",
  partial_delivered: "DELIVERED",
  cancelled_approval_pending: "RETURNED",
  cancelled: "RETURNED",
  unknown_approval_pending: "UNKNOWN",
  unknown: "UNKNOWN",
};

type Request = typeof requestJson;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const asText = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

export function createSteadfastProvider(cfg: CourierConfig, request: Request = requestJson): CourierProvider {
  const base = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    "Api-Key": cfg.apiKey ?? "",
    "Secret-Key": cfg.apiSecret ?? "",
  };
  const secrets = [cfg.apiKey, cfg.apiSecret];
  const clean = (t: string) => sanitizeProviderMessage(t, secrets);

  return {
    key: "steadfast",
    displayName: "Steadfast",

    async book(req: CourierBookingRequest): Promise<CourierBookingResult> {
      const result: HttpResult = await request(
        `${base}${CREATE_ORDER_PATH}`,
        {
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
        },
        cfg.timeoutMs,
      );

      if (result.kind === "network") return { ok: false, kind: "uncertain", message: clean(result.message) };
      if (result.kind === "invalid_response") {
        return { ok: false, kind: "uncertain", message: "The courier sent an unreadable response." };
      }
      if (result.kind === "http_error") {
        const body = asRecord(result.json);
        const msg = clean(asText(body?.message) ?? `The courier rejected the request (HTTP ${result.status}).`);
        // 4xx = the request itself was refused → nothing was created. 5xx = unknown.
        return result.status >= 400 && result.status < 500
          ? { ok: false, kind: "rejected", message: msg }
          : { ok: false, kind: "uncertain", message: msg };
      }

      const body = asRecord(result.json);
      const consignment = asRecord(body?.consignment);
      const consignmentId = asText(consignment?.consignment_id);
      if (body?.status === 200 && consignmentId) {
        return {
          ok: true,
          consignmentId,
          trackingCode: asText(consignment?.tracking_code),
          trackingUrl: null, // built from COURIER_TRACKING_URL_TEMPLATE if the store sets one
          providerStatus: asText(consignment?.status),
        };
      }
      // A 2xx whose body doesn't say "created": could be a soft rejection or a
      // shape we don't understand. Don't guess — flag it for manual checking.
      return {
        ok: false,
        kind: typeof body?.status === "number" && body.status >= 400 && body.status < 500 ? "rejected" : "uncertain",
        message: clean(asText(body?.message) ?? "The courier's reply did not confirm the booking."),
      };
    },

    async fetchStatus(consignmentId: string): Promise<CourierStatusResult> {
      // Read-only → one automatic retry on a network failure is safe.
      let result = await request(`${base}${STATUS_BY_CID_PATH}${encodeURIComponent(consignmentId)}`, { method: "GET", headers }, cfg.timeoutMs);
      if (result.kind === "network") {
        result = await request(`${base}${STATUS_BY_CID_PATH}${encodeURIComponent(consignmentId)}`, { method: "GET", headers }, cfg.timeoutMs);
      }
      if (result.kind !== "ok") return { ok: false, message: "Could not read the courier status right now." };
      const status = asText(asRecord(result.json)?.delivery_status);
      return status ? { ok: true, status } : { ok: false, message: "The courier's status reply was not understood." };
    },

    parseWebhook(body: unknown): ParsedWebhook | null {
      const b = asRecord(body);
      if (!b) return null;
      const status = asText(b.status);
      if (!status) return null;
      // Only delivery-status notifications drive order updates.
      if (b.notification_type !== undefined && b.notification_type !== "delivery_status") return null;
      return { consignmentId: asText(b.consignment_id), reference: asText(b.invoice), status: status.toLowerCase().slice(0, 64) };
    },

    mapStatus(raw: string): CourierEvent {
      return STATUS_MAP[raw.toLowerCase()] ?? "UNKNOWN";
    },
  };
}
