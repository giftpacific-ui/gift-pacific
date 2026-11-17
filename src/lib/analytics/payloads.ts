/**
 * Pure payload builders for the browser events (Meta Pixel, GA4, TikTok). No window access and no randomness: the caller supplies
 * the event id, so every shape here is deterministic and unit-tested (tests/unit/tracking-payloads.test.ts).
 *
 * Conventions
 *  - Currency defaults to BDT. Money is rounded to 2 decimals.
 *  - The product id is used for Meta `content_ids` / `contents[].id` AND GA4 `item_id`, so catalogue and analytics line up. If your
 *    Meta catalogue uses SKUs as retailer ids, change `itemId` here (one place).
 *  - Meta Purchase `value` is the total the customer pays. GA4 `purchase.value` is the item revenue after discounts (total minus
 *    shipping and tax), with tax / shipping / coupon sent as separate fields.
 *  - Customer data (name, email, phone, address) is never part of a browser payload.
 */

export type TrackedItem = {
  id: string;
  name: string;
  /** Unit price. */
  price: number;
  quantity: number;
  variant?: string | null;
};

export type Ga4Payload = {
  name: string;
  /** Flat params as gtag expects. For GTM they are nested under `ecommerce` when `ecommerce` is true. */
  params: Record<string, unknown>;
  ecommerce: boolean;
};
export type MetaPayload = { name: string; params: Record<string, unknown>; custom: boolean };
export type TikTokPayload = { name: string; params: Record<string, unknown> };

export type CommerceEvent = {
  /** Unique per occurrence; shared by every destination so a server-side copy (if one exists) can be de-duplicated. */
  eventId: string;
  ga4?: Ga4Payload;
  meta?: MetaPayload;
  tiktok?: TikTokPayload;
};

export const DEFAULT_CURRENCY = "BDT";
const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const qty = (n: number) => Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));

export const itemId = (item: Pick<TrackedItem, "id">) => item.id;

export function ga4Items(items: TrackedItem[]) {
  return items.map((i) => ({
    item_id: itemId(i),
    item_name: i.name,
    price: round2(i.price),
    quantity: qty(i.quantity),
    ...(i.variant ? { item_variant: i.variant } : {}),
  }));
}

export function metaContents(items: TrackedItem[]) {
  return items.map((i) => ({ id: itemId(i), quantity: qty(i.quantity), item_price: round2(i.price) }));
}

const sumValue = (items: TrackedItem[]) => round2(items.reduce((n, i) => n + i.price * qty(i.quantity), 0));
const numItems = (items: TrackedItem[]) => items.reduce((n, i) => n + qty(i.quantity), 0);
const contentIds = (items: TrackedItem[]) => [...new Set(items.map(itemId))];

function metaCommerce(items: TrackedItem[], value: number, currency: string) {
  return {
    content_type: "product",
    content_ids: contentIds(items),
    contents: metaContents(items),
    num_items: numItems(items),
    value: round2(value),
    currency,
  };
}

function tiktokCommerce(items: TrackedItem[], value: number, currency: string) {
  return {
    content_type: "product",
    contents: items.map((i) => ({ content_id: itemId(i), content_name: i.name, quantity: qty(i.quantity), price: round2(i.price) })),
    value: round2(value),
    currency,
  };
}

// ---------------------------------------------------------------------------------------------------------------- events

export function viewContentEvent(item: TrackedItem, eventId: string, currency = DEFAULT_CURRENCY): CommerceEvent {
  const items = [{ ...item, quantity: 1 }];
  const value = sumValue(items);
  return {
    eventId,
    ga4: { name: "view_item", ecommerce: true, params: { currency, value, items: ga4Items(items) } },
    meta: { name: "ViewContent", custom: false, params: { ...metaCommerce(items, value, currency), content_name: item.name } },
    tiktok: { name: "ViewContent", params: tiktokCommerce(items, value, currency) },
  };
}

export function searchEvent(query: string, eventId: string): CommerceEvent {
  const q = query.trim().slice(0, 100);
  return {
    eventId,
    ga4: { name: "search", ecommerce: false, params: { search_term: q } },
    meta: { name: "Search", custom: false, params: { search_string: q, content_type: "product" } },
    tiktok: { name: "Search", params: { query: q } },
  };
}

export function addToCartEvent(item: TrackedItem, eventId: string, currency = DEFAULT_CURRENCY): CommerceEvent {
  const items = [item];
  const value = sumValue(items);
  return {
    eventId,
    ga4: { name: "add_to_cart", ecommerce: true, params: { currency, value, items: ga4Items(items) } },
    meta: { name: "AddToCart", custom: false, params: { ...metaCommerce(items, value, currency), content_name: item.name } },
    tiktok: { name: "AddToCart", params: tiktokCommerce(items, value, currency) },
  };
}

/** Meta has no standard remove-from-cart event, so it is sent as a custom event of that name. */
export function removeFromCartEvent(item: TrackedItem, eventId: string, currency = DEFAULT_CURRENCY): CommerceEvent {
  const items = [item];
  const value = sumValue(items);
  return {
    eventId,
    ga4: { name: "remove_from_cart", ecommerce: true, params: { currency, value, items: ga4Items(items) } },
    meta: { name: "RemoveFromCart", custom: true, params: { ...metaCommerce(items, value, currency), content_name: item.name } },
  };
}

export function addToWishlistEvent(item: TrackedItem, eventId: string, currency = DEFAULT_CURRENCY): CommerceEvent {
  const items = [{ ...item, quantity: 1 }];
  const value = sumValue(items);
  return {
    eventId,
    ga4: { name: "add_to_wishlist", ecommerce: true, params: { currency, value, items: ga4Items(items) } },
    meta: { name: "AddToWishlist", custom: false, params: { ...metaCommerce(items, value, currency), content_name: item.name } },
  };
}

export function initiateCheckoutEvent(items: TrackedItem[], eventId: string, currency = DEFAULT_CURRENCY): CommerceEvent {
  const value = sumValue(items);
  return {
    eventId,
    ga4: { name: "begin_checkout", ecommerce: true, params: { currency, value, items: ga4Items(items) } },
    meta: { name: "InitiateCheckout", custom: false, params: metaCommerce(items, value, currency) },
    tiktok: { name: "InitiateCheckout", params: tiktokCommerce(items, value, currency) },
  };
}

export function addPaymentInfoEvent(items: TrackedItem[], paymentMethod: string, eventId: string, currency = DEFAULT_CURRENCY): CommerceEvent {
  const value = sumValue(items);
  return {
    eventId,
    ga4: { name: "add_payment_info", ecommerce: true, params: { currency, value, payment_type: paymentMethod, items: ga4Items(items) } },
    meta: { name: "AddPaymentInfo", custom: false, params: metaCommerce(items, value, currency) },
  };
}

/** A contact-form submission. `value` is intentionally absent: nothing was bought. */
export function leadEvent(eventId: string, source = "contact_form"): CommerceEvent {
  return {
    eventId,
    ga4: { name: "generate_lead", ecommerce: false, params: { lead_source: source } },
    meta: { name: "Lead", custom: false, params: { content_name: source } },
  };
}

export function completeRegistrationEvent(eventId: string, method = "email"): CommerceEvent {
  return {
    eventId,
    ga4: { name: "sign_up", ecommerce: false, params: { method } },
    meta: { name: "CompleteRegistration", custom: false, params: { status: true, content_name: method } },
  };
}

export type PurchaseInput = {
  orderNumber: string;
  /** What the customer pays (items - discounts + shipping + tax). */
  total: number;
  shipping: number;
  tax: number;
  coupon?: string | null;
  currency?: string;
  items: TrackedItem[];
};

/**
 * Browser Purchase. The event id is the SAME one the server uses (purchase_<orderNumber>) so Meta de-duplicates, and the GA4
 * transaction_id is the order number, which GA4 de-duplicates on.
 */
export function purchaseEvent(order: PurchaseInput, eventId: string): CommerceEvent {
  const currency = order.currency || DEFAULT_CURRENCY;
  const itemRevenue = round2(order.total - order.shipping - order.tax);
  return {
    eventId,
    ga4: {
      name: "purchase",
      ecommerce: true,
      params: {
        transaction_id: order.orderNumber,
        currency,
        value: itemRevenue,
        tax: round2(order.tax),
        shipping: round2(order.shipping),
        ...(order.coupon ? { coupon: order.coupon } : {}),
        items: ga4Items(order.items),
      },
    },
    meta: { name: "Purchase", custom: false, params: { ...metaCommerce(order.items, order.total, currency), order_id: order.orderNumber } },
    tiktok: { name: "CompletePayment", params: tiktokCommerce(order.items, order.total, currency) },
  };
}
