/** Pure rules for incomplete-checkout recovery (P7.2). No server imports: shared by the service, the admin UI and the tests. */
import { z } from "zod";
import { CHECKOUT_KEY_PATTERN } from "@/lib/checkout-key";

export const RECOVERY_DEFAULT_EXPIRY_DAYS = 30; // idle ACTIVE record -> EXPIRED and personal details scrubbed
export const RECOVERY_DEFAULT_PURGE_DAYS = 60; // EXPIRED record (no order) -> deleted this long after it expired
export const MAX_SNAPSHOT_LINES = 50;

export type RecoveryConfig = { enabled: boolean; expiryDays: number; purgeDays: number };

function intIn(value: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** CHECKOUT_RECOVERY_ENABLED (default on), CHECKOUT_RECOVERY_EXPIRY_DAYS (1-365, default 30), CHECKOUT_RECOVERY_PURGE_DAYS (7-730, default 60). Bad values fall back. */
export function recoveryConfig(env: Record<string, string | undefined> = process.env): RecoveryConfig {
  return {
    enabled: env.CHECKOUT_RECOVERY_ENABLED?.trim().toLowerCase() !== "false",
    expiryDays: intIn(env.CHECKOUT_RECOVERY_EXPIRY_DAYS, 1, 365, RECOVERY_DEFAULT_EXPIRY_DAYS),
    purgeDays: intIn(env.CHECKOUT_RECOVERY_PURGE_DAYS, 7, 730, RECOVERY_DEFAULT_PURGE_DAYS),
  };
}

/**
 * What the browser may send. STRICT: any other key (a password, OTP, card number, advance reference, note...) makes the whole request invalid,
 * so such data can never reach storage even by accident. `consent` must be literally true.
 */
export const checkoutProgressSchema = z.strictObject({
  consent: z.literal(true),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(32).optional(),
  deliveryZone: z.enum(["DHAKA_CITY", "OUTSIDE_DHAKA", "OTHER"]).optional(),
  couponCode: z.string().trim().max(40).optional(),
  checkoutKey: z.string().trim().regex(CHECKOUT_KEY_PATTERN).optional().or(z.literal("")),
  shippingAddress: z
    .strictObject({
      fullName: z.string().trim().max(100).optional(),
      line1: z.string().trim().max(200).optional(),
      line2: z.string().trim().max(200).optional(),
      city: z.string().trim().max(80).optional(),
      state: z.string().trim().max(80).optional(),
      postalCode: z.string().trim().max(20).optional(),
      country: z.string().trim().max(60).optional(),
    })
    .optional(),
});
export type CheckoutProgressInput = z.infer<typeof checkoutProgressSchema>;

/** Sufficient = at least one VALID contact (e-mail or Bangladesh mobile). Nothing is stored before that. */
export function hasSufficientContact(contact: { email: string | null; phoneNorm: string | null }): boolean {
  return Boolean(contact.email || contact.phoneNorm);
}

export const RECOVERY_STATUS_LABEL = {
  ACTIVE: "Not recovered",
  CONVERTED: "Recovered (order placed)",
  EXPIRED: "Expired",
} as const;

export type SnapshotLine = { productId: string; variantId: string | null; name: string; variant: string | null; quantity: number; unitPrice: number; unavailable: boolean };

/** Defensive reader for the stored JSON (never trusts its shape). */
export function readSnapshotLines(value: unknown): SnapshotLine[] {
  if (!Array.isArray(value)) return [];
  const out: SnapshotLine[] = [];
  for (const v of value.slice(0, MAX_SNAPSHOT_LINES)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    out.push({
      productId: String(r.productId ?? ""),
      variantId: typeof r.variantId === "string" ? r.variantId : null,
      name: String(r.name ?? ""),
      variant: typeof r.variant === "string" ? r.variant : null,
      quantity: Number(r.quantity) || 0,
      unitPrice: Number(r.unitPrice) || 0,
      unavailable: r.unavailable === true,
    });
  }
  return out;
}
