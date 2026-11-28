/**
 * Courier configuration — read lazily from the server environment (never
 * from the client bundle, never from the database). See README "Courier
 * integration" for the variable list.
 *
 *   COURIER_PROVIDER             "none" (default) | "steadfast"
 *   COURIER_API_KEY              provider API key
 *   COURIER_API_SECRET           provider API secret
 *   COURIER_API_BASE_URL         optional override of the provider's base URL (https only)
 *   COURIER_WEBHOOK_SECRET       shared secret the provider sends to our webhook
 *   COURIER_TIMEOUT_MS           per-request timeout (default 10000, 1000–30000)
 *   COURIER_TRACKING_URL_TEMPLATE optional, e.g. https://courier.example/track/{id}
 *   STEADFAST_INVOICE_LOOKUP     "true" enables the reference (invoice) lookup used to settle UNCERTAIN bookings. Off by default:
 *                                that endpoint is documented by Steadfast's own client package but is not in the current official
 *                                Postman collection, so it must be confirmed on staging first.
 */
export const SUPPORTED_COURIERS = ["steadfast"] as const;
export type SupportedCourier = (typeof SUPPORTED_COURIERS)[number];

export type CourierConfig = {
  provider: SupportedCourier | null;
  apiKey: string | null;
  apiSecret: string | null;
  baseUrl: string | null;
  webhookSecret: string | null;
  timeoutMs: number;
  trackingUrlTemplate: string | null;
  /** Reference lookup for uncertain-booking recovery is explicitly switched on (never by default). */
  invoiceLookup: boolean;
  /** Human-readable reason booking is unavailable (admin-facing), or null if it's usable. */
  problem: string | null;
};

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

function isAllowedBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol === "https:") return true;
    // plain http is only acceptable for a local mock server
    return u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
  } catch {
    return false;
  }
}

const PREFIX: Record<SupportedCourier, string> = { steadfast: "STEADFAST" };
const isSupported = (v: string): v is SupportedCourier => (SUPPORTED_COURIERS as readonly string[]).includes(v);

/**
 * Configuration of ONE courier, independent of the others.
 *  - New style: <PREFIX>_ENABLED, <PREFIX>_API_KEY, <PREFIX>_API_SECRET, <PREFIX>_API_BASE_URL, <PREFIX>_WEBHOOK_SECRET,
 *    <PREFIX>_TIMEOUT_MS, <PREFIX>_TRACKING_URL_TEMPLATE (Steadfast: STEADFAST_*).
 *  - Legacy (still honoured): COURIER_* apply to the provider named by COURIER_PROVIDER, exactly as before. A new-style
 *    variable, when set, wins over its legacy twin.
 * Credentials exist only in the server environment; nothing here is ever sent to the browser.
 */
export function getCourierProviderConfig(key: SupportedCourier, env: Env = process.env): CourierConfig {
  const prefix = PREFIX[key];
  const legacyOn = (clean(env.COURIER_PROVIDER) ?? "none").toLowerCase() === key;
  const get = (name: string) => clean(env[`${prefix}_${name}`]) ?? (legacyOn ? clean(env[`COURIER_${name}`]) : null);
  const newStyle = ["API_KEY", "API_SECRET", "ENABLED"].some((n) => clean(env[`${prefix}_${n}`]));
  const label = (name: string) => `${legacyOn && !newStyle ? "COURIER" : prefix}_${name}`;

  const timeout = Number(get("TIMEOUT_MS"));
  const base: CourierConfig = {
    provider: key,
    apiKey: get("API_KEY"),
    apiSecret: get("API_SECRET"),
    baseUrl: get("API_BASE_URL"),
    webhookSecret: get("WEBHOOK_SECRET"),
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 30000 ? Math.floor(timeout) : 10000,
    trackingUrlTemplate: null,
    invoiceLookup: (get("INVOICE_LOOKUP") ?? "").toLowerCase() === "true",
    problem: null,
  };
  base.trackingUrlTemplate = parseTrackingUrlTemplate(get("TRACKING_URL_TEMPLATE"));

  if (clean(env[`${prefix}_ENABLED`])?.toLowerCase() === "false") return { ...base, problem: `Switched off (${prefix}_ENABLED=false).` };
  if (!base.apiKey && !base.apiSecret && !legacyOn && !newStyle) return { ...base, provider: null, problem: "Not configured." };
  if (!base.apiKey || !base.apiSecret) return { ...base, problem: `${label("API_KEY")} / ${label("API_SECRET")} are not set.` };
  if (base.baseUrl && !isAllowedBaseUrl(base.baseUrl)) return { ...base, problem: `${label("API_BASE_URL")} must be an https URL.` };
  return base;
}

/** True when the courier was deliberately switched off (<PREFIX>_ENABLED=false), as opposed to merely not configured. */
export function isCourierSwitchedOff(key: SupportedCourier, env: Env = process.env): boolean {
  return clean(env[`${PREFIX[key]}_ENABLED`])?.toLowerCase() === "false";
}

export type DefaultCourierChoice =
  | { key: SupportedCourier; reason: "explicit" | "only_configured" | "first_configured"; message: string }
  | { key: null; reason: "none_configured" | "explicit_unavailable" | "explicit_unsupported"; message: string };

/**
 * Which courier is used when the admin does not pick one, and WHY (the admin screens show the reason).
 *  1. COURIER_DEFAULT_PROVIDER, else the legacy COURIER_PROVIDER, when it names a courier: that courier, and only that one. If it is not
 *     usable (missing credentials, switched off) or has no adapter, there is NO automatic courier: parcels are never silently routed to a
 *     different courier than the one the owner named.
 *  2. Nothing named (unset or "none"): the only fully configured courier, or the first one in registry order when several are.
 *  3. Nothing configured: no default (manual booking only).
 */
export function describeDefaultCourier(env: Env = process.env): DefaultCourierChoice {
  const raw = (clean(env.COURIER_DEFAULT_PROVIDER) ?? clean(env.COURIER_PROVIDER) ?? "none").toLowerCase();
  if (raw === "none") {
    const usable = SUPPORTED_COURIERS.filter((k) => isCourierUsable(getCourierProviderConfig(k, env)));
    if (usable.length === 0) return { key: null, reason: "none_configured", message: "No courier provider is configured (COURIER_PROVIDER)." };
    return usable.length === 1
      ? { key: usable[0], reason: "only_configured", message: `${usable[0]} is the only configured courier, so it is used automatically.` }
      : { key: usable[0], reason: "first_configured", message: `Several couriers are configured and none is named as the default, so ${usable[0]} is used automatically.` };
  }
  if (isSupported(raw)) {
    const cfg = getCourierProviderConfig(raw, env);
    return isCourierUsable(cfg)
      ? { key: raw, reason: "explicit", message: `${raw} is the configured default courier.` }
      : { key: null, reason: "explicit_unavailable", message: cfg.problem ?? `${raw} is not usable.` };
  }
  return {
    key: null,
    reason: "explicit_unsupported",
    message: `Unsupported COURIER_PROVIDER "${raw}": no API adapter exists for it (supported: ${SUPPORTED_COURIERS.join(", ")}). Leave it unset for automatic selection, or record bookings by hand.`,
  };
}

/** The courier configuration used when nothing else is chosen (see describeDefaultCourier). Behaves exactly as before when only the legacy variables are set. */
export function getCourierConfig(env: Env = process.env): CourierConfig {
  const choice = describeDefaultCourier(env);
  if (choice.key) return getCourierProviderConfig(choice.key, env);
  const raw = (clean(env.COURIER_DEFAULT_PROVIDER) ?? clean(env.COURIER_PROVIDER) ?? "none").toLowerCase();
  // The named courier exists but is not usable: surface ITS problem (as always), with its key, so the admin sees what to fix.
  if (choice.reason === "explicit_unavailable" && isSupported(raw)) return getCourierProviderConfig(raw, env);
  const empty: CourierConfig = { provider: null, apiKey: null, apiSecret: null, baseUrl: null, webhookSecret: null, timeoutMs: 10000, trackingUrlTemplate: null, invoiceLookup: false, problem: null };
  return { ...empty, problem: choice.message };
}

export function isCourierUsable(cfg: CourierConfig): boolean {
  return cfg.provider !== null && cfg.problem === null;
}

/**
 * Accepts a tracking URL template only if it is an https URL, contains {id}, and the placeholder is NOT part of the host
 * (so a tracking ID can never choose which site the link points to). Anything else is treated as "no template" (null).
 * The template is operator-supplied configuration: this app does not know or assume any official courier URL.
 */
export function parseTrackingUrlTemplate(raw: string | null | undefined): string | null {
  const template = raw?.trim();
  if (!template || !template.includes("{id}")) return null;
  // https://<host without braces>/...  — braces (the placeholder) may appear only after the host.
  if (!/^https:\/\/[^\s/?#{}]+(?=[/?#])/i.test(template)) return null;
  if (/\s/.test(template)) return null;
  const withoutPlaceholder = template.replaceAll("{id}", "x");
  if (/[{}]/.test(withoutPlaceholder)) return null; // some other placeholder we don't understand
  try {
    const u = new URL(withoutPlaceholder);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  } catch {
    return null;
  }
  return template;
}

/**
 * Builds a tracking URL from the optional template. Returns null (never a broken or invented URL) when there is no valid
 * template or no usable ID. The ID is URL-encoded, so it cannot add path segments, query parameters or fragments.
 */
export function buildTrackingUrl(cfg: CourierConfig, id: string | null | undefined): string | null {
  const template = parseTrackingUrlTemplate(cfg.trackingUrlTemplate);
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!template || !trimmed || trimmed.length > 200) return null;
  const url = template.replaceAll("{id}", encodeURIComponent(trimmed));
  return url.length <= 500 ? url : null; // 500 = the limit the manual-entry path already applies to trackingUrl
}
