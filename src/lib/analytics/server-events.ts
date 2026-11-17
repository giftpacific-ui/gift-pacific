import "server-only";
import { createHash } from "node:crypto";
import { isValidPixelId } from "@/lib/analytics/ids";
import { isValidFbc, isValidFbp } from "@/lib/analytics/attribution";

/**
 * Meta Conversions API client: payload building, customer-data hashing, delivery and failure classification.
 *
 * This is the SERVER half of the existing Pixel integration (src/lib/analytics/meta-pixel.ts). It is deliberately free of database
 * access: src/server/services/tracking-event.service.ts decides WHETHER an event may be sent (order state, consent, idempotency)
 * and calls into this module to build and deliver it.
 *
 * - The access token only ever lives in META_CONVERSIONS_API_TOKEN, is sent in the request body (never in the URL) and is redacted
 *   from every error string this module returns.
 * - Email, phone, name, city, country and external id are normalised then SHA-256 hashed. client_ip_address, client_user_agent,
 *   fbc and fbp are sent RAW because Meta requires that.
 * - Nothing here throws: a failure becomes a `{ ok: false }` result so tracking can never break an order.
 */

/** Graph API version. v20.0 was scheduled for deprecation on 2026-09-24; override with META_GRAPH_API_VERSION when Meta retires this one. */
export const META_API_VERSION_DEFAULT = "v25.0";
export const META_REQUEST_TIMEOUT_MS = 5_000;

export function resolveApiVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.META_GRAPH_API_VERSION?.trim();
  return v && /^v\d{2}\.\d$/.test(v) ? v : META_API_VERSION_DEFAULT;
}

// ------------------------------------------------------------------------------------------------------------------ hashing

export const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export const normalizeEmail = (v: string | null | undefined): string | undefined => {
  const e = (v ?? "").trim().toLowerCase();
  return e.includes("@") && e.length <= 254 ? e : undefined;
};

/** Digits only, country code included, no leading zeros / symbols. Bangladesh numbers (01XXXXXXXXX) become 8801XXXXXXXXX. */
export function normalizePhone(raw: string | null | undefined, countryCode = "880"): string | undefined {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (!d) return undefined;
  if (!d.startsWith(countryCode)) {
    if (d.startsWith("0")) d = countryCode + d.slice(1);
    else if (d.length === 10 && d.startsWith("1")) d = countryCode + d;
  }
  return d.length >= 10 && d.length <= 15 ? d : undefined;
}

export const normalizeName = (v: string | null | undefined): string | undefined => {
  const n = (v ?? "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
  return n || undefined;
};

export const normalizeCity = normalizeName;

/** Lower-case ISO 3166-1 alpha-2. Accepts "BD" / "bd" / "Bangladesh"; anything else is omitted rather than guessed. */
export function normalizeCountry(v: string | null | undefined): string | undefined {
  const c = (v ?? "").trim().toLowerCase();
  if (c === "bangladesh") return "bd";
  return /^[a-z]{2}$/.test(c) ? c : undefined;
}

export type MetaUserDataInput = {
  email?: string | null;
  phone?: string | null;
  fullName?: string | null;
  city?: string | null;
  country?: string | null;
  /** Our own customer id (logged-in buyers only). Hashed. */
  userId?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export function buildUserData(input: MetaUserDataInput, now = Date.now()): Record<string, unknown> {
  const hashed = (v: string | undefined) => (v ? [sha256(v)] : undefined);
  const parts = (input.fullName ?? "").trim().split(/\s+/).filter(Boolean);
  const out: Record<string, unknown> = {
    em: hashed(normalizeEmail(input.email)),
    ph: hashed(normalizePhone(input.phone)),
    fn: hashed(normalizeName(parts[0])),
    ln: hashed(parts.length > 1 ? normalizeName(parts[parts.length - 1]) : undefined),
    ct: hashed(normalizeCity(input.city)),
    country: hashed(normalizeCountry(input.country)),
    external_id: hashed(input.userId?.trim() || undefined),
    // RAW by Meta's rules (hashing these makes them useless):
    client_ip_address: input.ip || undefined,
    client_user_agent: input.userAgent || undefined,
    fbc: isValidFbc(input.fbc, now) ? input.fbc : undefined,
    fbp: isValidFbp(input.fbp, now) ? input.fbp : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ payload

export type PurchaseOrderInput = {
  orderNumber: string;
  /** Total the customer pays (items - discounts + shipping + tax), in `currency`. */
  total: number;
  currency: string;
  email: string | null;
  phone: string | null;
  userId: string | null;
  shipping: { fullName?: string | null; city?: string | null; country?: string | null };
  items: { productId: string; quantity: number; unitPrice: number }[];
};

export type MetaServerEvent = {
  event_name: "Purchase";
  event_time: number;
  event_id: string;
  action_source: "website" | "other";
  event_source_url?: string;
  user_data: Record<string, unknown>;
  custom_data: Record<string, unknown>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Builds the server Purchase from SERVER order data only. `eventTime` is when the order was confirmed (retries keep it).
 * action_source is "website" only when a browser user agent was captured at checkout (Meta requires one for website events);
 * otherwise "other" is used rather than sending an event Meta would reject.
 */
export function buildPurchaseEvent(args: {
  order: PurchaseOrderInput;
  eventId: string;
  eventTime: Date;
  /** Absolute URL of the page the order came from (the checkout), never one containing the order number. */
  sourceUrl: string;
  attribution?: { fbc?: string | null; fbp?: string | null; ip?: string | null; userAgent?: string | null };
  now?: number;
}): MetaServerEvent {
  const { order, attribution } = args;
  const hasBrowserContext = Boolean(attribution?.userAgent);
  const ids = [...new Set(order.items.map((i) => i.productId))];
  const event: MetaServerEvent = {
    event_name: "Purchase",
    event_time: Math.floor(args.eventTime.getTime() / 1000),
    event_id: args.eventId,
    action_source: hasBrowserContext ? "website" : "other",
    ...(hasBrowserContext ? { event_source_url: args.sourceUrl } : {}),
    user_data: buildUserData(
      {
        email: order.email,
        phone: order.phone,
        fullName: order.shipping.fullName,
        city: order.shipping.city,
        country: order.shipping.country,
        userId: order.userId,
        fbc: attribution?.fbc,
        fbp: attribution?.fbp,
        ip: attribution?.ip,
        userAgent: attribution?.userAgent,
      },
      args.now,
    ),
    custom_data: {
      currency: order.currency || "BDT",
      value: round2(order.total),
      content_type: "product",
      content_ids: ids,
      contents: order.items.map((i) => ({ id: i.productId, quantity: i.quantity, item_price: round2(i.unitPrice) })),
      num_items: order.items.reduce((n, i) => n + i.quantity, 0),
      order_id: order.orderNumber,
    },
  };
  return event;
}

// ------------------------------------------------------------------------------------------------------------------ config

export type MetaConfig = { pixelId: string; accessToken: string; apiVersion: string; testEventCode?: string };
export type MetaConfigResult = { ok: true; config: MetaConfig } | { ok: false; reason: "no_pixel" | "invalid_pixel" | "no_token" };

/** The SAME effective pixel id the browser uses: the admin setting first, then NEXT_PUBLIC_META_PIXEL_ID. */
export function resolveMetaConfig(settingsPixelId: string | null | undefined, env: Record<string, string | undefined> = process.env): MetaConfigResult {
  const candidate = (settingsPixelId || env.NEXT_PUBLIC_META_PIXEL_ID || "").trim();
  if (!candidate) return { ok: false, reason: "no_pixel" };
  if (!isValidPixelId(candidate)) return { ok: false, reason: "invalid_pixel" }; // it is placed in a URL path
  const accessToken = env.META_CONVERSIONS_API_TOKEN?.trim();
  if (!accessToken) return { ok: false, reason: "no_token" };
  const test = env.META_CAPI_TEST_EVENT_CODE?.trim();
  return {
    ok: true,
    config: { pixelId: candidate, accessToken, apiVersion: resolveApiVersion(env), ...(test && /^[A-Za-z0-9_-]{3,40}$/.test(test) ? { testEventCode: test } : {}) },
  };
}

// ------------------------------------------------------------------------------------------------------------------ delivery

export type MetaSendResult =
  | { ok: true; httpStatus: number; fbtraceId?: string }
  | { ok: false; retryable: boolean; httpStatus?: number; code?: string; message: string; fbtraceId?: string };

/** Removes anything that must not reach a log, the database or the admin UI: the token, emails, long digit runs (phones). */
export function redactSensitive(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b(EAA|EAAG)[A-Za-z0-9]{10,}\b/g, "[token]")
    .replace(/\d[\d\s().+-]{7,}\d/g, "[number]")
    .slice(0, 300);
}

/** Meta error codes documented as temporary (rate limits, transient service errors). */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

type MetaErrorBody = { error?: { message?: string; type?: string; code?: number; error_subcode?: number; is_transient?: boolean; fbtrace_id?: string } };
type MetaResponseBody = MetaErrorBody & { events_received?: number; fbtrace_id?: string };

export function classifyMetaFailure(httpStatus: number, body: MetaErrorBody | null): { retryable: boolean; code?: string } {
  const err = body?.error;
  const code = err?.code !== undefined ? String(err.code) : undefined;
  if (httpStatus === 429 || httpStatus >= 500) return { retryable: true, code };
  if (err?.is_transient === true) return { retryable: true, code };
  if (typeof err?.code === "number" && TRANSIENT_CODES.has(err.code)) return { retryable: true, code };
  return { retryable: false, code }; // e.g. 190 invalid token, 100 invalid parameter: retrying cannot help until an admin fixes it
}

/**
 * POSTs events to the Conversions API. Never throws. Network errors and timeouts are retryable; HTTP/Graph errors are classified.
 * The request is aborted after `timeoutMs` so a slow Meta can never hold a request open.
 */
export async function sendMetaEvents(
  config: MetaConfig,
  events: MetaServerEvent[],
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<MetaSendResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? META_REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`https://graph.facebook.com/${config.apiVersion}/${config.pixelId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ data: events, access_token: config.accessToken, ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}) }),
    });
    let body: MetaResponseBody | null = null;
    try {
      body = (await res.json()) as MetaResponseBody | null;
    } catch {
      body = null;
    }
    const fbtraceId = body?.fbtrace_id ?? body?.error?.fbtrace_id;
    if (res.ok) {
      if (typeof body?.events_received === "number" && body.events_received < 1) {
        return { ok: false, retryable: false, httpStatus: res.status, message: "Meta accepted the request but received no events.", fbtraceId };
      }
      return { ok: true, httpStatus: res.status, fbtraceId };
    }
    const { retryable, code } = classifyMetaFailure(res.status, body);
    return {
      ok: false,
      retryable,
      httpStatus: res.status,
      code,
      message: redactSensitive(body?.error?.message ?? `Meta responded with HTTP ${res.status}.`, [config.accessToken]),
      fbtraceId,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      retryable: true,
      code: aborted ? "timeout" : "network",
      message: aborted ? `No response from Meta within ${(options.timeoutMs ?? META_REQUEST_TIMEOUT_MS) / 1000}s.` : "Could not reach Meta.",
    };
  } finally {
    clearTimeout(timer);
  }
}
