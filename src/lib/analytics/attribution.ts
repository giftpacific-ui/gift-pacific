/**
 * Attribution rules (pure, unit-tested; imported by both the browser capture component and the server snapshot).
 *
 * What is captured (only on an "eligible" landing - one that carries a campaign signal or an external referrer):
 *   utm_source / utm_medium / utm_campaign / utm_content / utm_term, campaign_id / adset_id / ad_id, placement,
 *   fbclid, landing PATH (never the query string), referrer HOST (never the full referrer URL).
 *
 * First touch is written once and never overwritten. Last touch is replaced by every later eligible landing; a plain direct
 * visit never replaces it. A first visit with no signal is stored as a "direct" first touch (landing + time only) so a LATER
 * paid click can never masquerade as the original first touch.
 *
 * The cookie is client-controlled. So EVERY value is re-validated by `parseAttributionCookie` before the server stores it:
 * text is length-capped and stripped of markup characters, ids must be numeric, fbclid/fbc/fbp must match their real shapes,
 * timestamps must be sane and unresolved ad-platform macros ("{{campaign.name}}") are dropped. Attribution is reporting data
 * only - it never changes an order's total or what value is sent to an ad platform.
 */
import { analyticsPath, isTrackablePath } from "@/lib/analytics/privacy";
import { isValidConsentRef } from "@/lib/analytics/consent-ref";

export const ATTRIBUTION_COOKIE = "gp_attr";
export const ATTRIBUTION_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;
const MAX_COOKIE_VALUE_LENGTH = 3000;
const DAY_MS = 86_400_000;

export type Touch = {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  campaignId?: string;
  adsetId?: string;
  adId?: string;
  placement?: string;
  fbclid?: string;
  /** Path only, e.g. "/products/rose-box". */
  landing?: string;
  /** Hostname only, e.g. "l.facebook.com". */
  referrerHost?: string;
  /** Epoch ms of the landing. */
  at: number;
};

export type AttributionCookie = { v: 1; first?: Touch; last?: Touch };

// ---------------------------------------------------------------------------------------------------------------- cleaners

/** Free text from a URL parameter. Drops markup/quote characters and control characters; unresolved `{{macro}}` placeholders are rejected. */
export function cleanText(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.includes("{{") || value.includes("}}")) return undefined; // the ad platform did not substitute its macro
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>"'`\\;{}]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, max);
}

/** Meta campaign / ad set / ad ids are numeric. */
export function cleanNumericId(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{5,25}$/.test(value.trim()) ? value.trim() : undefined;
}

export function cleanFbclid(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,300}$/.test(value.trim()) ? value.trim() : undefined;
}

/** A same-site path (no query/hash, no protocol-relative or external form). */
export function cleanLandingPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.split(/[?#]/)[0];
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined;
  const cleaned = cleanText(path, 200);
  return cleaned && cleaned.startsWith("/") ? cleaned : undefined;
}

export function cleanHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const host = value.trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]{0,98}[a-z0-9])?$/.test(host) && host.includes(".") ? host : undefined;
}

/** Hostname of an external referrer, or undefined for direct / internal navigation. */
export function referrerHostOf(referrer: string | null | undefined, ownHost: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    const own = ownHost.toLowerCase().replace(/:\d+$/, "");
    if (!host || host === own || host === `www.${own}` || `www.${host}` === own) return undefined;
    return cleanHost(host);
  } catch {
    return undefined;
  }
}

const saneTime = (v: unknown, now: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 1_000_000_000_000 && v <= now + DAY_MS ? Math.floor(v) : undefined;

// ---------------------------------------------------------------------------------------------------------------- Meta ids

/** `fb.<subdomain index>.<ms timestamp>.<fbclid>`; the click id is case-sensitive and must be kept verbatim. */
export function isValidFbc(value: unknown, now = Date.now()): value is string {
  if (typeof value !== "string") return false;
  const m = /^fb\.[0-2]\.(\d{10,13})\.([A-Za-z0-9_-]{8,500})$/.exec(value);
  return !!m && Number(m[1]) <= now + DAY_MS;
}

export function isValidFbp(value: unknown, now = Date.now()): value is string {
  if (typeof value !== "string") return false;
  const m = /^fb\.[0-2]\.(\d{10,13})\.(\d{1,20})$/.exec(value);
  return !!m && Number(m[1]) <= now + DAY_MS;
}

export function fbcFromFbclid(fbclid: string, now = Date.now()): string {
  return `fb.1.${now}.${fbclid}`;
}

// ---------------------------------------------------------------------------------------------------------------- touches

export const hasCampaignSignal = (t: Touch): boolean =>
  Boolean(t.source || t.medium || t.campaign || t.content || t.term || t.campaignId || t.adsetId || t.adId || t.placement || t.fbclid);

/** Rebuilds a Touch from untrusted data, keeping only valid fields. Returns undefined if no valid timestamp. */
export function sanitizeTouch(input: unknown, now = Date.now()): Touch | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const at = saneTime(o.at, now);
  if (!at) return undefined;
  const touch: Touch = { at };
  const set = <K extends keyof Touch>(k: K, v: Touch[K] | undefined) => {
    if (v !== undefined) touch[k] = v;
  };
  set("source", cleanText(o.source, 100));
  set("medium", cleanText(o.medium, 100));
  set("campaign", cleanText(o.campaign, 150));
  set("content", cleanText(o.content, 150));
  set("term", cleanText(o.term, 150));
  set("campaignId", cleanNumericId(o.campaignId));
  set("adsetId", cleanNumericId(o.adsetId));
  set("adId", cleanNumericId(o.adId));
  set("placement", cleanText(o.placement, 60));
  set("fbclid", cleanFbclid(o.fbclid));
  set("landing", cleanLandingPath(o.landing));
  set("referrerHost", cleanHost(o.referrerHost));
  return touch;
}

/**
 * Builds the touch for the current page load. Returns null when this page must not be captured at all (private routes).
 * A touch with no signal and no external referrer is a plain "direct" visit (landing + time only).
 */
export function touchFromLocation(args: { pathname: string; search: string; referrer?: string | null; ownHost: string; now?: number }): Touch | null {
  const now = args.now ?? Date.now();
  if (!isTrackablePath(args.pathname)) return null;
  const q = new URLSearchParams(args.search);
  const touch: Touch = { at: now };
  const set = <K extends keyof Touch>(k: K, v: Touch[K] | undefined) => {
    if (v !== undefined) touch[k] = v;
  };
  set("source", cleanText(q.get("utm_source"), 100));
  set("medium", cleanText(q.get("utm_medium"), 100));
  set("campaign", cleanText(q.get("utm_campaign"), 150));
  set("content", cleanText(q.get("utm_content"), 150));
  set("term", cleanText(q.get("utm_term"), 150));
  set("campaignId", cleanNumericId(q.get("campaign_id")));
  set("adsetId", cleanNumericId(q.get("adset_id")));
  set("adId", cleanNumericId(q.get("ad_id")));
  set("placement", cleanText(q.get("placement"), 60));
  set("fbclid", cleanFbclid(q.get("fbclid")));
  // analyticsPath() removes an order number from a confirmation URL: no order reference ever lands in attribution data.
  set("landing", cleanLandingPath(analyticsPath(args.pathname)));
  set("referrerHost", referrerHostOf(args.referrer, args.ownHost));
  return touch;
}

/** A touch worth becoming the new last touch: it carries a campaign signal or comes from another site. */
export const isEligibleForLastTouch = (t: Touch): boolean => hasCampaignSignal(t) || Boolean(t.referrerHost);

/**
 * Applies a new landing to the stored attribution.
 *  - first: written once, never overwritten.
 *  - last: replaced only by an eligible touch (direct visits keep the previous last touch).
 */
export function mergeAttribution(existing: AttributionCookie | null, touch: Touch | null): { cookie: AttributionCookie | null; changed: boolean } {
  if (!touch) return { cookie: existing, changed: false };
  const next: AttributionCookie = { v: 1, ...(existing?.first ? { first: existing.first } : {}), ...(existing?.last ? { last: existing.last } : {}) };
  let changed = false;
  if (!next.first) {
    next.first = touch;
    changed = true;
  }
  if (isEligibleForLastTouch(touch)) {
    // Same campaign data as what is already stored => nothing new to record.
    const prev = next.last;
    const same = prev && JSON.stringify({ ...prev, at: 0, landing: "" }) === JSON.stringify({ ...touch, at: 0, landing: "" });
    if (!same) {
      next.last = touch;
      changed = true;
    }
  }
  return { cookie: changed ? next : existing, changed };
}

// ---------------------------------------------------------------------------------------------------------------- cookie

export function serializeAttributionCookie(cookie: AttributionCookie): string {
  let json = JSON.stringify(cookie);
  // Keep well under the 4 KB browser limit: drop the oldest detail (first touch's free text) rather than overflow.
  if (encodeURIComponent(json).length > MAX_COOKIE_VALUE_LENGTH && cookie.first) {
    const { at, landing, source, medium, campaign, campaignId, adsetId, adId, fbclid, referrerHost } = cookie.first;
    json = JSON.stringify({ ...cookie, first: { at, landing, source, medium, campaign, campaignId, adsetId, adId, fbclid, referrerHost } });
  }
  return encodeURIComponent(json);
}

/** The server's validation gate for the (client-controlled) cookie. Returns null for anything unusable. */
export function parseAttributionCookie(raw: string | null | undefined, now = Date.now()): AttributionCookie | null {
  if (!raw || raw.length > MAX_COOKIE_VALUE_LENGTH * 2) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1) return null;
    const first = sanitizeTouch(o.first, now);
    const last = sanitizeTouch(o.last, now);
    if (!first && !last) return null;
    return { v: 1, ...(first ? { first } : {}), ...(last ? { last } : {}) };
  } catch {
    return null;
  }
}

/** Best fbc for an order: a valid `_fbc` cookie wins; otherwise one derived from the stored fbclid (last touch preferred). */
export function resolveFbc(cookieFbc: string | undefined, attribution: AttributionCookie | null, now = Date.now()): string | undefined {
  if (isValidFbc(cookieFbc, now)) return cookieFbc;
  const t = attribution?.last?.fbclid ? attribution.last : attribution?.first?.fbclid ? attribution.first : undefined;
  return t?.fbclid ? fbcFromFbclid(t.fbclid, t.at) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------- GA4 identifiers

/**
 * GA client id from the `_ga` cookie (`GA1.<n>.<random>.<timestamp>` -> `<random>.<timestamp>`). The cookie is client-controlled,
 * so only the two numeric parts in their real shape are accepted; anything else is dropped rather than guessed or repaired.
 */
export function gaClientIdFromCookie(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length > 64) return undefined;
  const parts = raw.trim().split(".");
  if (parts.length < 4 || !/^GA\d$/.test(parts[0]) || !/^\d$/.test(parts[1])) return undefined;
  const id = `${parts[2]}.${parts[3]}`;
  return /^\d{3,12}\.\d{9,11}$/.test(id) ? id : undefined;
}

/** Session id from the `_ga_<MEASUREMENT>` cookie, in either the GS1 (`GS1.1.<id>.…`) or GS2 (`GS2.1.s<id>$o…`) format. */
export function gaSessionIdFromCookie(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length > 200) return undefined;
  const m = /^GS1\.\d\.(\d{9,11})\./.exec(raw) ?? /^GS2\.\d\.s(\d{9,11})\$/.exec(raw);
  return m?.[1];
}

/** `G-ABC123` -> `_ga_ABC123`: the name of the session cookie for that measurement id. */
export const gaSessionCookieName = (measurementId: string): string => `_ga_${measurementId.replace(/^G-/i, "")}`;

// ---------------------------------------------------------------------------------------------------------------- order snapshot

/** Syntactic IP check (no node:net so this file stays usable in the browser bundle). */
export function cleanIp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ip = value.trim();
  const v4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ip);
  const v6 = ip.length <= 45 && /^[0-9a-fA-F:.]+$/.test(ip) && (ip.match(/:/g)?.length ?? 0) >= 2;
  return v4 || v6 ? ip : undefined;
}

export function cleanUserAgent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const ua = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 512);
  return ua || undefined;
}

/** First address of an X-Forwarded-For list, falling back to X-Real-IP. Only used for ad matching, and validated. */
export function clientIpFromHeaders(get: (name: string) => string | null | undefined): string | undefined {
  const xff = get("x-forwarded-for")?.split(",")[0];
  return cleanIp(xff) ?? cleanIp(get("x-real-ip"));
}

export type OrderAttributionRecord = {
  firstTouch: Touch | null;
  lastTouch: Touch | null;
  fbc: string | null;
  fbp: string | null;
  clientIp: string | null;
  clientUserAgent: string | null;
  gaClientId: string | null;
  gaSessionId: string | null;
  consentRef: string | null;
  consentState: "GRANTED" | "DENIED" | "UNKNOWN" | "NOT_REQUIRED";
};

/**
 * What is stored for an order, decided on the SERVER from the raw request values.
 * Under OPT_IN without an explicit grant ONLY the consent state is kept: no attribution, no fbc/fbp, no IP, no user agent.
 */
export function buildOrderAttributionRecord(args: {
  consentState: OrderAttributionRecord["consentState"];
  attributionCookie?: string | null;
  fbcCookie?: string | null;
  fbpCookie?: string | null;
  /** Raw `_ga` / `_ga_<id>` cookies. Pass them only when the server GA4 purchase is configured (data minimisation). */
  gaCookie?: string | null;
  gaSessionCookie?: string | null;
  consentRefCookie?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  now?: number;
}): OrderAttributionRecord {
  const now = args.now ?? Date.now();
  const permitted = args.consentState === "GRANTED" || args.consentState === "NOT_REQUIRED";
  if (!permitted) {
    return { firstTouch: null, lastTouch: null, fbc: null, fbp: null, clientIp: null, clientUserAgent: null, gaClientId: null, gaSessionId: null, consentRef: null, consentState: args.consentState };
  }
  const attribution = parseAttributionCookie(args.attributionCookie, now);
  return {
    firstTouch: attribution?.first ?? null,
    lastTouch: attribution?.last ?? null,
    fbc: resolveFbc(args.fbcCookie ?? undefined, attribution, now) ?? null,
    fbp: isValidFbp(args.fbpCookie, now) ? (args.fbpCookie as string) : null,
    clientIp: cleanIp(args.ip) ?? null,
    clientUserAgent: cleanUserAgent(args.userAgent) ?? null,
    gaClientId: gaClientIdFromCookie(args.gaCookie) ?? null,
    gaSessionId: gaSessionIdFromCookie(args.gaSessionCookie) ?? null,
    consentRef: isValidConsentRef(args.consentRefCookie) ? args.consentRefCookie : null,
    consentState: args.consentState,
  };
}
