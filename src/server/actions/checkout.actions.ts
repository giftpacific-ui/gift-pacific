"use server";

import { prisma } from "@/lib/db/prisma";
import { quoteAdvance } from "@/server/services/advance.service";
import { getSession } from "@/lib/auth/current-user";
import { checkoutSchema, type CheckoutInput } from "@/lib/validations/checkout";
import { placeOrder } from "@/server/services/order.service";
import { validateCoupon } from "@/server/services/coupon.service";
import { getCurrentCartDTO } from "@/server/services/cart.service";
import { getAllDeliveryCharges } from "@/server/services/delivery.service";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { trackServerEvent } from "@/lib/analytics/server-events";
import { toUserMessage } from "@/lib/errors";
import { setConfirmationCookie } from "@/server/confirmation";
import { purchaseEventId } from "@/lib/analytics/ids";

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

export type CheckoutActionState =
  // The confirmation token is delivered in an httpOnly cookie, never in this
  // response or in any URL (it would leak via history, Referer and analytics).
  | { success: true; orderNumber: string }
  | { success: false; message: string };

export async function submitCheckout(input: CheckoutInput): Promise<CheckoutActionState> {
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: "Please check the form for errors." };
  }

  try {
    const order = await placeOrder({
      email: parsed.data.email,
      phone: parsed.data.phone,
      shippingAddress: parsed.data.shippingAddress,
      billingAddress: parsed.data.billingSameAsShipping
        ? null
        : ((parsed.data.billingAddress ?? null) as typeof parsed.data.shippingAddress | null),
      billingSameAsShipping: parsed.data.billingSameAsShipping,
      paymentMethod: parsed.data.paymentMethod,
      deliveryZone: parsed.data.deliveryZone,
      couponCode: parsed.data.couponCode || null,
      rewardId: parsed.data.rewardId || null,
      advanceMethod: parsed.data.advanceMethod ?? null,
      advanceReference: parsed.data.advanceReference || null,
      customerNote: parsed.data.customerNote || null,
    });

    await setConfirmationCookie(order.orderNumber, order.confirmationToken);

    // Optional server-side copy (only if a Conversions API token is set); the
    // shared event id lets Meta count it together with the browser event once.
            // The order already exists: nothing in this analytics block may turn a successful
    // checkout into an error (a customer who sees one might order again).
    try {
      const settings = await getStoreSettings();
      await trackServerEvent(
        "Purchase",
        { value: Number(order.total), currency: order.currency, order_id: order.orderNumber },
        purchaseEventId(order.orderNumber),
        { pixelId: settings.metaPixelId, consentMode: settings.consentMode },
      );
    } catch {
      // ignored on purpose
    }

    return { success: true, orderNumber: order.orderNumber };
  } catch (error) {
    return {
      success: false,
      message: toUserMessage(error, "Could not place your order. Please try again.", "checkout.place-order"),
    };
  }
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
