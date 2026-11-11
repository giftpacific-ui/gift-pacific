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
    problem: null,
  };
  const template = get("TRACKING_URL_TEMPLATE");
  if (template && template.includes("{id}") && /^https:\/\//i.test(template)) base.trackingUrlTemplate = template;

  if (clean(env[`${prefix}_ENABLED`])?.toLowerCase() === "false") return { ...base, problem: `Switched off (${prefix}_ENABLED=false).` };
  if (!base.apiKey && !base.apiSecret && !legacyOn && !newStyle) return { ...base, provider: null, problem: "Not configured." };
  if (!base.apiKey || !base.apiSecret) return { ...base, problem: `${label("API_KEY")} / ${label("API_SECRET")} are not set.` };
  if (base.baseUrl && !isAllowedBaseUrl(base.baseUrl)) return { ...base, problem: `${label("API_BASE_URL")} must be an https URL.` };
  return base;
}

/**
 * The courier used when nothing else is chosen: COURIER_DEFAULT_PROVIDER, else the legacy COURIER_PROVIDER, else the first
 * courier that is fully configured. With only the legacy variables set this behaves exactly as it always did.
 */
export function getCourierConfig(env: Env = process.env): CourierConfig {
  const raw = (clean(env.COURIER_DEFAULT_PROVIDER) ?? clean(env.COURIER_PROVIDER) ?? "none").toLowerCase();
  if (isSupported(raw)) return getCourierProviderConfig(raw, env);
  const usable = SUPPORTED_COURIERS.map((k) => getCourierProviderConfig(k, env)).find((c) => c.provider !== null && c.problem === null);
  if (usable) return usable;
  const empty: CourierConfig = { provider: null, apiKey: null, apiSecret: null, baseUrl: null, webhookSecret: null, timeoutMs: 10000, trackingUrlTemplate: null, problem: null };
  return { ...empty, problem: raw === "none" ? "No courier provider is configured (COURIER_PROVIDER)." : `Unsupported COURIER_PROVIDER "${raw}".` };
}

export function isCourierUsable(cfg: CourierConfig): boolean {
  return cfg.provider !== null && cfg.problem === null;
}

/** Builds a tracking URL from the optional template; never invents one. */
export function buildTrackingUrl(cfg: CourierConfig, id: string | null): string | null {
  if (!cfg.trackingUrlTemplate || !id) return null;
  return cfg.trackingUrlTemplate.replace("{id}", encodeURIComponent(id));
}
