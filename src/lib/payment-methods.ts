import { UserFacingError } from "@/lib/errors";

/**
 * V1 supports Cash on Delivery only. Stripe and SSLCommerz exist in the
 * `PaymentMethod` enum (so the schema doesn't need a migration when they're
 * built) but have NO charge/webhook flow, so an order must never be created
 * with them — otherwise a crafted request could "place" an order that is
 * never actually paid for.
 *
 * This is the single source of truth. It is enforced in two places on the
 * server (the checkout zod schema AND `placeOrder`), not just hidden in the UI.
 */
export const ENABLED_PAYMENT_METHODS = ["COD"] as const;
export type EnabledPaymentMethod = (typeof ENABLED_PAYMENT_METHODS)[number];

export function isPaymentMethodEnabled(method: unknown): method is EnabledPaymentMethod {
  return (
    typeof method === "string" &&
    (ENABLED_PAYMENT_METHODS as readonly string[]).includes(method)
  );
}

export class PaymentMethodNotSupportedError extends UserFacingError {
  constructor() {
    super("Cash on Delivery is the only payment method currently available.");
    this.name = "PaymentMethodNotSupportedError";
  }
}

export function assertPaymentMethodEnabled(
  method: unknown,
): asserts method is EnabledPaymentMethod {
  if (!isPaymentMethodEnabled(method)) throw new PaymentMethodNotSupportedError();
}
