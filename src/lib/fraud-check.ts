import type { FraudCheckHistory } from "@/lib/advance-policy";

/**
 * Pure helpers for fraud-check ADAPTERS. No provider contract lives here: the caller supplies the mapping from the provider's own status strings,
 * and that mapping must come from the provider's OFFICIAL documentation. Nothing in this file knows any provider's statuses.
 */
export type ParcelBucket = "delivered" | "cancelled" | "returned" | "other";

/**
 * Counts DISTINCT parcels. The same parcel id repeated with the same bucket counts once (duplicate records cannot inflate a score).
 * The same id with CONFLICTING buckets, an empty id, or a status the mapping does not know (`null`) makes the whole answer unusable (throws):
 * it is never guessed or counted as positive.
 */
export function aggregateParcels(parcels: ReadonlyArray<{ id: string; status: string }>, mapStatus: (status: string) => ParcelBucket | null): FraudCheckHistory {
  const seen = new Map<string, ParcelBucket>();
  for (const p of parcels) {
    const id = typeof p?.id === "string" ? p.id.trim() : "";
    if (!id) throw new Error("fraud-check parcel without an id");
    const bucket = mapStatus(p.status);
    if (bucket === null) throw new Error("fraud-check parcel with an unmapped status");
    const prev = seen.get(id);
    if (prev !== undefined && prev !== bucket) throw new Error("fraud-check parcel listed with conflicting statuses");
    seen.set(id, bucket);
  }
  const h = { delivered: 0, cancelled: 0, returned: 0, total: seen.size };
  for (const b of seen.values()) if (b !== "other") h[b]++;
  return h;
}

/** True only for a well-formed counts object (non-negative integers; `returned` and `total` optional, total >= the parts). Used on every provider answer before it is trusted. */
export function isValidFraudHistory(h: unknown): h is FraudCheckHistory {
  if (!h || typeof h !== "object") return false;
  const o = h as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (!(ok(o.delivered) && ok(o.cancelled) && (o.returned === undefined || ok(o.returned)) && (o.total === undefined || ok(o.total)))) return false;
  // A total smaller than its own parts is contradictory: reject the whole answer.
  return o.total === undefined || (o.total as number) >= (o.delivered as number) + (o.cancelled as number) + ((o.returned as number | undefined) ?? 0);
}

/** Fraud-check providers that have an adapter. The registry in fraud-check.service.ts must contain exactly these (a test keeps them equal). */
export const KNOWN_FRAUD_PROVIDERS = ["steadfast"] as const;

/** Why a provider adapter could not give a usable answer. The service turns these into the matching `unavailable` reason. */
export type FraudProviderFailure = "timeout" | "error" | "invalid_response" | "rate_limited" | "auth_failed" | "no_counts";

/**
 * Thrown by an adapter to say precisely why there is no usable answer. Carries ONLY a reason code: never a message from the provider, a URL, a
 * phone number or a credential, so nothing sensitive can travel with it into logs.
 */
export class FraudCheckProviderError extends Error {
  readonly reason: FraudProviderFailure;
  constructor(reason: FraudProviderFailure) {
    super(reason);
    this.name = "FraudCheckProviderError";
    this.reason = reason;
  }
}
