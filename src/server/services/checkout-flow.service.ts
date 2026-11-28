import "server-only";
import { getSession } from "@/lib/auth/current-user";
import type { CheckoutInput } from "@/lib/validations/checkout";
import { placeOrder } from "@/server/services/order.service";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { snapshotOrderAttribution } from "@/server/services/order-attribution.service";
import { toUserMessage } from "@/lib/errors";
import { RATE_LIMITS, clientAddress, consumeRateLimit, throttledMessage } from "@/lib/rate-limit";
import { normalizeBdPhone } from "@/lib/fraud/identity";
import { findCheckoutReplay, resolveLostRace, shouldRejectAtCheckout } from "@/server/services/checkout-guard.service";
import { evaluateOrderRisk } from "@/server/services/fraud-risk.service";
import { setConfirmationCookie } from "@/server/confirmation";
import { markCheckoutConverted } from "@/server/services/incomplete-checkout.service";

// The confirmation token is delivered in an httpOnly cookie, never in this result or in any URL (it would leak via history, Referer and analytics).
export type CheckoutResult = { success: true; orderNumber: string } | { success: false; message: string };

/**
 * Everything that happens to an already-VALIDATED checkout submission: replay of an identical submission, optional block-reject, rate limits, placement,
 * attribution, early fraud-risk evaluation. Lives here (not in the "use server" action) so it can be tested without the zod schema; the action only parses.
 */
export async function processCheckout(data: CheckoutInput): Promise<CheckoutResult> {
  const session = await getSession();
  const key = data.checkoutKey || null;
  const who = { userId: session?.sub ?? null, phone: data.phone };

  // 1. The SAME submission arriving again (double click, retry after a lost response): hand back the order it already created. Not counted against rate limits.
  const replay = await findCheckoutReplay(key, who);
  if (replay?.kind === "replay") {
    await setConfirmationCookie(replay.orderNumber, replay.confirmationToken ?? "");
    return { success: true, orderNumber: replay.orderNumber };
  }
  if (replay?.kind === "mismatch") {
    return { success: false, message: "This checkout was already submitted. Please check your orders, or start a new checkout." };
  }

  // 2. Only when the admin chose "reject" for blocked phone / e-mail. The message never reveals why, or that a list exists.
  const ip = await clientAddress();
  if (await shouldRejectAtCheckout({ phone: data.phone, email: data.email, ip })) {
    return { success: false, message: "We could not process this order online. Please contact us to complete it." };
  }

  // 3. Brakes on checkout abuse. The per-phone limit is the tight one; the IP limit is generous (shared networks) and skipped when no address is known.
  const phoneKey = normalizeBdPhone(data.phone) ?? data.phone;
  for (const [rule, id] of [[RATE_LIMITS.checkoutPhone, phoneKey], ...(ip !== "unknown" ? ([[RATE_LIMITS.checkoutIp, ip]] as const) : [])] as const) {
    const limited = await consumeRateLimit(rule, [id]);
    if (!limited.ok) return { success: false, message: throttledMessage(limited) };
  }

  try {
    const order = await placeOrder({
      checkoutKey: key,
      email: data.email,
      phone: data.phone,
      shippingAddress: data.shippingAddress,
      billingAddress: data.billingSameAsShipping
        ? null
        : ((data.billingAddress ?? null) as typeof data.shippingAddress | null),
      billingSameAsShipping: data.billingSameAsShipping,
      paymentMethod: data.paymentMethod,
      deliveryZone: data.deliveryZone,
      couponCode: data.couponCode || null,
      rewardId: data.rewardId || null,
      advanceMethod: data.advanceMethod ?? null,
      advanceReference: data.advanceReference || null,
      customerNote: data.customerNote || null,
    });

    await setConfirmationCookie(order.orderNumber, order.confirmationToken);

    // P7.2: the visitor's saved incomplete checkout (if any) becomes CONVERTED and is linked to this order. Never throws.
    await markCheckoutConverted(order.id, key);

    // NO Purchase event here: creating an order is not a purchase. The server Purchase is queued when the merchant CONFIRMS the
    // order (adminUpdateOrderStatus -> tracking-event.service; policy in lib/analytics/purchase-policy.ts).
    // What IS recorded now is the visitor's attribution and consent state, snapshotted once from first-party cookies and
    // re-validated on the server. The order already exists: nothing in this block may turn a successful checkout into an error
    // (a customer who sees one might order again), and snapshotOrderAttribution never throws.
    try {
      const settings = await getStoreSettings();
      await snapshotOrderAttribution(order, settings.consentMode);
    } catch {
      // ignored on purpose
    }

    // Fraud risk (P4): an early evaluation with the visitor's address as the SERVER saw it. It only ever sets the review gate for the admin; it never refuses,
    // delays or alters this checkout, and any failure is ignored here (the admin's confirm step evaluates again, and refuses an order that was never assessed).
    try {
      await evaluateOrderRisk(order.id, { trigger: "CHECKOUT", ip });
    } catch {
      // ignored on purpose
    }

    return { success: true, orderNumber: order.orderNumber };
  } catch (error) {
    // A concurrent request with the SAME key may have won the race (it claimed the cart first): then its order IS this submission's result.
    try {
      const lost = await resolveLostRace(key, who);
      if (lost?.kind === "replay") {
        await setConfirmationCookie(lost.orderNumber, lost.confirmationToken ?? "");
        return { success: true, orderNumber: lost.orderNumber };
      }
    } catch {
      // fall through to the original error
    }
    return {
      success: false,
      message: toUserMessage(error, "Could not place your order. Please try again.", "checkout.place-order"),
    };
  }
}
