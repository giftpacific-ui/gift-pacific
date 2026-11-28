import { getCourierConfig, getCourierProviderConfig, isCourierUsable, type CourierConfig, type SupportedCourier } from "@/lib/courier/config";
import { createSteadfastProvider, mapSteadfastStatus, steadfastStatusRank, isSteadfastFinal } from "@/lib/courier/steadfast";
import type { CourierEvent, CourierProvider } from "@/lib/courier/types";

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

/**
 * Credential-free status vocabulary of a courier (mapping, progress rank, finality). Needed where a stored raw status must be interpreted
 * without a usable provider (admin lists, attention rules): it never needs keys and never makes a network call.
 */
export type StatusMapper = { map(raw: string): CourierEvent; rank(raw: string): number | null; isFinal(raw: string): boolean };
export function statusMapperFor(key: string | null | undefined): StatusMapper | null {
  switch (key) {
    case "steadfast":
      return { map: mapSteadfastStatus, rank: steadfastStatusRank, isFinal: isSteadfastFinal };
    default:
      return null;
  }
}
