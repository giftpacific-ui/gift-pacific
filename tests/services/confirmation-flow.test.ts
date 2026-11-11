/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog } from "../setup/helpers";
import { addItemToCart } from "@/server/services/cart.service";
import { getOrderForConfirmation, placeOrder } from "@/server/services/order.service";
import { readConfirmationToken, setConfirmationCookie } from "@/server/confirmation";

const jar = (globalThis as any).__TEST_COOKIES__ as Map<string, { value: string; options: any }>;
beforeEach(() => { jar.clear(); seedCatalog(freshDb()); });

test("guest confirmation: the secret travels in an httpOnly cookie, not the URL", async () => {
  await runAs(null, () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const order = await runAs(null, () => placeOrder(emptyCheckout));
  await setConfirmationCookie(order.orderNumber, order.confirmationToken);

  const cookie = jar.get("giftpacific_order_conf")!;
  assert.ok(cookie, "cookie was set");
  assert.deepEqual(
    [cookie.options.httpOnly, cookie.options.sameSite, cookie.options.path, cookie.options.maxAge],
    [true, "lax", "/checkout/confirmation", 86400],
  );

  // the confirmation page logic: token read from the cookie, never from a query string
  const token = await readConfirmationToken(order.orderNumber);
  const view = await runAs(null, () => getOrderForConfirmation(order.orderNumber, token));
  assert.equal(view?.orderNumber, order.orderNumber);

  // without the cookie (or with another order's cookie) the order is NOT disclosed
  jar.clear();
  const noToken = await readConfirmationToken(order.orderNumber);
  assert.equal(noToken, undefined);
  assert.equal(await runAs(null, () => getOrderForConfirmation(order.orderNumber, noToken)), null);
  await setConfirmationCookie("AP-202610-999999", "x".repeat(25));
  assert.equal(await readConfirmationToken(order.orderNumber), undefined);
  assert.equal(await runAs(null, () => getOrderForConfirmation(order.orderNumber, "guess")), null);
});

test("malformed order numbers / tokens never create a cookie", async () => {
  await setConfirmationCookie("not-an-order", "x".repeat(25));
  await setConfirmationCookie("AP-202610-000001", "short");
  assert.equal(jar.size, 0);
});

test("a confirmation cookie issued before the rebrand (legacy name) still opens that order, and only that order", async () => {
  await runAs(null, () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const order = await runAs(null, () => placeOrder(emptyCheckout));
  // branding-guard:allow (documented legacy compatibility, see HANDOFF_GIFTPACIFIC.md)
  jar.set("ap_order_conf", { value: `${order.orderNumber}.${order.confirmationToken}`, options: {} });
  assert.equal(await readConfirmationToken(order.orderNumber), order.confirmationToken);
  assert.equal(await readConfirmationToken("AP-202610-999999"), undefined);
  // a newer cookie for a different order must not hide the legacy cookie of this one
  await setConfirmationCookie("AP-202610-999999", "y".repeat(25));
  assert.equal(await readConfirmationToken(order.orderNumber), order.confirmationToken);
});
