import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addPaymentInfoEvent, addToCartEvent, addToWishlistEvent, completeRegistrationEvent, initiateCheckoutEvent, leadEvent,
  purchaseEvent, removeFromCartEvent, searchEvent, viewContentEvent, type TrackedItem,
} from "@/lib/analytics/payloads";
import { purchaseEventId } from "@/lib/analytics/ids";

const mug: TrackedItem = { id: "p-mug", name: "Clay Mug", price: 650, quantity: 2, variant: "Red" };
const vase: TrackedItem = { id: "p-vase", name: "Vase", price: 1800.5, quantity: 1 };

test("Pixel + GA4 payloads: ViewContent / AddToCart carry BDT, value, content_ids, content_type and contents with id, quantity, item_price", () => {
  const v = viewContentEvent(mug, "e1");
  assert.equal(v.meta?.name, "ViewContent");
  assert.deepEqual(v.meta?.params.content_ids, ["p-mug"]);
  assert.equal(v.meta?.params.content_type, "product");
  assert.equal(v.meta?.params.currency, "BDT");
  assert.equal(v.meta?.params.value, 650); // viewing one unit, regardless of the quantity field
  assert.deepEqual(v.meta?.params.contents, [{ id: "p-mug", quantity: 1, item_price: 650 }]);
  assert.equal(v.ga4?.name, "view_item");

  const a = addToCartEvent(mug, "e2");
  assert.equal(a.meta?.name, "AddToCart");
  assert.equal(a.meta?.params.value, 1300);
  assert.deepEqual(a.meta?.params.contents, [{ id: "p-mug", quantity: 2, item_price: 650 }]);
  assert.equal(a.meta?.params.num_items, 2);
  assert.equal(a.ga4?.name, "add_to_cart");
  assert.deepEqual((a.ga4?.params.items as object[])[0], { item_id: "p-mug", item_name: "Clay Mug", price: 650, quantity: 2, item_variant: "Red" });
  assert.equal(a.ga4?.params.currency, "BDT");
  assert.equal(a.ga4?.params.value, 1300);
});

test("RemoveFromCart: GA4 remove_from_cart + a CUSTOM Meta event (Meta has no standard one)", () => {
  const r = removeFromCartEvent(mug, "e3");
  assert.equal(r.ga4?.name, "remove_from_cart");
  assert.equal(r.meta?.name, "RemoveFromCart");
  assert.equal(r.meta?.custom, true);
  assert.equal(r.meta?.params.value, 1300);
});

test("Search, Lead, CompleteRegistration, AddToWishlist use the standard names and send no customer data", () => {
  assert.equal(searchEvent("  rose box ", "e").meta?.params.search_string, "rose box");
  assert.equal(searchEvent("x", "e").ga4?.name, "search");
  assert.equal(leadEvent("e").meta?.name, "Lead");
  assert.equal(leadEvent("e").ga4?.name, "generate_lead");
  assert.equal(completeRegistrationEvent("e").meta?.name, "CompleteRegistration");
  assert.equal(completeRegistrationEvent("e").ga4?.name, "sign_up");
  const w = addToWishlistEvent(vase, "e");
  assert.equal(w.meta?.name, "AddToWishlist");
  assert.equal(w.ga4?.name, "add_to_wishlist");
  for (const ev of [leadEvent("e"), completeRegistrationEvent("e"), w]) {
    assert.ok(!/@|\d{9,}/.test(JSON.stringify(ev)), "no email address or phone number in a browser payload");
  }
});

test("InitiateCheckout / AddPaymentInfo include every line with quantity, the value and (GA4) the payment type", () => {
  const ic = initiateCheckoutEvent([mug, vase], "e");
  assert.equal(ic.meta?.name, "InitiateCheckout");
  assert.equal(ic.ga4?.name, "begin_checkout");
  assert.equal(ic.meta?.params.value, 3100.5);
  assert.equal(ic.meta?.params.num_items, 3);
  assert.deepEqual(ic.meta?.params.content_ids, ["p-mug", "p-vase"]);
  const pi = addPaymentInfoEvent([mug], "COD", "e");
  assert.equal(pi.meta?.name, "AddPaymentInfo");
  assert.equal(pi.ga4?.name, "add_payment_info");
  assert.equal(pi.ga4?.params.payment_type, "COD");
  assert.equal(pi.ga4?.params.value, 1300);
});

test("Purchase: GA4 has transaction_id, currency, value (items net of discount), tax, shipping, coupon and items; Meta has order_id and total value", () => {
  const order = { orderNumber: "GP-100", total: 3290.5, shipping: 70, tax: 20, coupon: "WELCOME10", items: [mug, vase] };
  const p = purchaseEvent(order, purchaseEventId("GP-100"));
  assert.equal(p.eventId, "purchase_GP-100");
  assert.deepEqual(
    { ...p.ga4?.params, items: undefined },
    { transaction_id: "GP-100", currency: "BDT", value: 3200.5, tax: 20, shipping: 70, coupon: "WELCOME10", items: undefined },
  );
  assert.equal((p.ga4?.params.items as unknown[]).length, 2);
  assert.equal(p.ga4?.ecommerce, true);
  assert.equal(p.meta?.name, "Purchase");
  assert.equal(p.meta?.params.value, 3290.5);
  assert.equal(p.meta?.params.order_id, "GP-100");
  assert.equal(p.meta?.params.currency, "BDT");
  // No coupon => the field is omitted, not sent as null/empty.
  assert.ok(!("coupon" in (purchaseEvent({ ...order, coupon: null }, "e").ga4?.params ?? {})));
});

test("quantities and money are normalised (no zero/NaN/float noise reaches an ad platform)", () => {
  const e = addToCartEvent({ id: "x", name: "n", price: 0.1 + 0.2, quantity: 0 }, "e");
  assert.equal(e.meta?.params.value, 0.3);
  assert.deepEqual(e.meta?.params.contents, [{ id: "x", quantity: 1, item_price: 0.3 }]);
});
