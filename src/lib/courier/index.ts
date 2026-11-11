import { getCourierConfig, getCourierProviderConfig, isCourierUsable, type CourierConfig, type SupportedCourier } from "@/lib/courier/config";
import { createSteadfastProvider } from "@/lib/courier/steadfast";
import type { CourierProvider } from "@/lib/courier/types";

/** The configured provider adapter, or null when API booking isn't set up (manual entry still works). */
export function getCourierProvider(cfg: CourierConfig = getCourierConfig()): CourierProvider | null {
  if (!isCourierUsable(cfg)) return null;
  switch (cfg.provider) {
    case "steadfast":
      return createSteadfastProvider(cfg);
    default:
      return null;
  }
}

/** A specific courier's adapter, configured independently of the default (null when that courier is not usable). */
export function getCourierProviderByKey(key: SupportedCourier, env: Record<string, string | undefined> = process.env): { config: CourierConfig; provider: CourierProvider | null } {
  const config = getCourierProviderConfig(key, env);
  return { config, provider: getCourierProvider(config) };
}
