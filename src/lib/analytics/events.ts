"use client";

import { emitCommerceEvent } from "@/lib/analytics/tracking-state";
import { purchaseEventId } from "@/lib/analytics/ids";
import {
  addPaymentInfoEvent,
  addToCartEvent,
  addToWishlistEvent,
  completeRegistrationEvent,
  initiateCheckoutEvent,
  leadEvent,
  purchaseEvent,
  removeFromCartEvent,
  searchEvent,
  viewContentEvent,
  type PurchaseInput,
  type TrackedItem,
} from "@/lib/analytics/payloads";

/**
 * The only module the rest of the app calls for tracking. Each function builds one payload (src/lib/analytics/payloads.ts, unit
 * tested) and hands it to the consent gate (tracking-state.ts), which delivers it to whichever of GA4/GTM, Meta Pixel and TikTok are
 * configured - or drops it when consent is missing. Product code never touches gtag/fbq/dataLayer directly.
 *
 * PageView is NOT here: the Pixel and GA4 snippets send the first one on load and RouteChangeTracker sends later route changes.
 * Purchase is fired only from the order confirmation page, and only for an order that is already confirmed (see TrackPurchase).
 */

type ProductLike = { id: string; name: string; price: number; currency?: string; variant?: string | null };

/** Unique per occurrence. Shared by every destination so a server-side copy (if one existed) could be de-duplicated. */
export function newEventId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${rand}`;
}

const item = (p: ProductLike, quantity = 1): TrackedItem => ({ id: p.id, name: p.name, price: p.price, quantity, variant: p.variant });

export function trackViewContent(product: ProductLike) {
  emitCommerceEvent(viewContentEvent(item(product), newEventId("vc"), product.currency));
}

export function trackSearch(query: string) {
  if (!query.trim()) return;
  emitCommerceEvent(searchEvent(query, newEventId("search")));
}

export function trackAddToCart(product: ProductLike, quantity: number) {
  emitCommerceEvent(addToCartEvent(item(product, quantity), newEventId("atc"), product.currency));
}

export function trackRemoveFromCart(product: ProductLike, quantity: number) {
  emitCommerceEvent(removeFromCartEvent(item(product, quantity), newEventId("rfc"), product.currency));
}

export function trackAddToWishlist(product: ProductLike) {
  emitCommerceEvent(addToWishlistEvent(item(product), newEventId("wl"), product.currency));
}

export function trackInitiateCheckout(items: TrackedItem[], currency = "BDT") {
  emitCommerceEvent(initiateCheckoutEvent(items, newEventId("ic"), currency));
}

export function trackAddPaymentInfo(items: TrackedItem[], paymentMethod: string, currency = "BDT") {
  emitCommerceEvent(addPaymentInfoEvent(items, paymentMethod, newEventId("api"), currency));
}

export function trackLead(source = "contact_form") {
  emitCommerceEvent(leadEvent(newEventId("lead"), source));
}

export function trackCompleteRegistration(method = "email") {
  emitCommerceEvent(completeRegistrationEvent(newEventId("reg"), method));
}

/**
 * At most once per order (see TrackPurchase). Sends no customer data. The event id is purchase_<orderNumber> - the same id the
 * server-side Conversions API event uses - so Meta counts the two as one.
 */
export function trackPurchase(order: PurchaseInput, options: { includeGa4?: boolean } = {}) {
  emitCommerceEvent(purchaseEvent(order, purchaseEventId(order.orderNumber), options));
}
