import { SUPPORTED_COURIERS, getCourierProviderConfig, isCourierUsable, type SupportedCourier } from "@/lib/courier/config";

type Env = Record<string, string | undefined>;

export type CourierProviderKey = "steadfast" | "pathao" | "redx";

export type CourierCapabilities = {
  /** The provider's pickup stores can be listed/selected from here. */
  pickupStores: boolean;
  /** An API booking can be cancelled from here. */
  cancel: boolean;
};

export type CourierProviderInfo = {
  key: CourierProviderKey;
  label: string;
  /** A working adapter exists in this codebase. Pathao and RedX have none: their API contracts were not provided. */
  adapterAvailable: boolean;
  /** Why the provider cannot be used yet (null when an adapter exists). */
  blocker: string | null;
  capabilities: CourierCapabilities;
  /** Environment variable prefix, only for providers that have an adapter. */
  envPrefix: string | null;
};

/**
 * Every courier the store may use. Adding one is: write its adapter (lib/courier/<provider>.ts), add it to
 * SUPPORTED_COURIERS / PREFIX in config.ts and createProvider in index.ts, then flip adapterAvailable. Nothing else is provider-specific.
 * Capabilities stay false until an adapter genuinely implements them.
 */
export const COURIER_PROVIDERS: CourierProviderInfo[] = [
  { key: "steadfast", label: "Steadfast", adapterAvailable: true, blocker: null, capabilities: { pickupStores: false, cancel: false }, envPrefix: "STEADFAST" },
  { key: "pathao", label: "Pathao", adapterAvailable: false, blocker: "Not available: no adapter. Needs Pathao's official merchant API documentation (token issue/refresh, stores, city/zone/area ids, order create and status responses, webhook signature and status list, cancellation) and merchant credentials. Nothing here can be selected or booked.", capabilities: { pickupStores: false, cancel: false }, envPrefix: null },
  { key: "redx", label: "RedX", adapterAvailable: false, blocker: "Not available: no adapter. Needs RedX's official API documentation (create/track response formats, delivery-area and pickup-store endpoints, status list, webhook, cancellation) and a merchant access token. Nothing here can be selected or booked.", capabilities: { pickupStores: false, cancel: false }, envPrefix: null },
];

export type CourierProviderStatus = CourierProviderInfo & {
  usable: boolean;
  /** Admin-facing reason it cannot be used, or null. Never contains a secret value. */
  problem: string | null;
  hasWebhookSecret: boolean;
  customBaseUrl: boolean;
};

/** Status of every provider for admin screens. Booleans and messages only: no credential value ever leaves this function. */
export function getCourierProviderStatuses(env: Env = process.env): CourierProviderStatus[] {
  return COURIER_PROVIDERS.map((info) => {
    if (!info.adapterAvailable) return { ...info, usable: false, problem: info.blocker, hasWebhookSecret: false, customBaseUrl: false };
    const cfg = getCourierProviderConfig(info.key as SupportedCourier, env);
    return { ...info, usable: isCourierUsable(cfg), problem: cfg.problem, hasWebhookSecret: Boolean(cfg.webhookSecret), customBaseUrl: Boolean(cfg.baseUrl) };
  });
}

export const usableCourierProviders = (env: Env = process.env) => getCourierProviderStatuses(env).filter((p) => p.usable);
export const isSupportedCourierKey = (v: unknown): v is SupportedCourier => typeof v === "string" && (SUPPORTED_COURIERS as readonly string[]).includes(v);
