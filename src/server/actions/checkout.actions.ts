"use server";

import { prisma } from "@/lib/db/prisma";
import { quoteAdvance } from "@/server/services/advance.service";
import { getSession } from "@/lib/auth/current-user";
import { checkoutSchema, type CheckoutInput } from "@/lib/validations/checkout";
import { processCheckout, type CheckoutResult } from "@/server/services/checkout-flow.service";
import { validateCoupon } from "@/server/services/coupon.service";
import { getCurrentCartDTO } from "@/server/services/cart.service";
import { getAllDeliveryCharges } from "@/server/services/delivery.service";

export async function getDeliveryChargesAction() {
  return getAllDeliveryCharges();
}

/**
 * What advance (if any) this visitor must send for a delivery zone. Computed from the server-side policy and the caller's own
 * history; only the amount and the merchant's instructions are returned — never the trust score or its reasons.
 */
export async function getAdvanceQuoteAction(zone: string): Promise<{ required: number; instructions: string | null }> {
  if (!["DHAKA_CITY", "OUTSIDE_DHAKA", "OTHER"].includes(zone)) return { required: 0, instructions: null };
  const q = await quoteAdvance(prisma, { zone: zone as "DHAKA_CITY" | "OUTSIDE_DHAKA" | "OTHER", orderTotal: 1_000_000_000 });
  return { required: q.decision.required, instructions: q.decision.required > 0 ? q.settings.instructions : null };
}

// The confirmation token is delivered in an httpOnly cookie, never in this response or in any URL (it would leak via history, Referer and analytics).
export type CheckoutActionState = CheckoutResult;

export async function submitCheckout(input: CheckoutInput): Promise<CheckoutActionState> {
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: "Please check the form for errors." };
  }
  return processCheckout(parsed.data);
}

export async function checkCoupon(
  code: string,
): Promise<
  | { valid: true; discountAmount: number; type: "PERCENTAGE" | "FIXED"; value: number }
  | { valid: false; message: string }
> {
  const session = await getSession();
  const cart = await getCurrentCartDTO();
  const subtotal = cart.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  const result = await validateCoupon(code, subtotal, session?.sub ?? null);
  if (!result.valid) return result;

  return {
    valid: true,
    discountAmount: result.discountAmount,
    type: result.coupon.type,
    value: Number(result.coupon.value),
  };
}
