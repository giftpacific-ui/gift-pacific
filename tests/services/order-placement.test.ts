import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { placeOrder } from "@/server/services/order.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); seedCatalog(db); });
const guest = <T,>(fn: () => Promise<T>) => runAs(null, fn);
const stockOf = (table: string, id: string) => db.get(table, id).stock as number;

test("payment: STRIPE and SSLCOMMERZ are rejected server-side and create NOTHING", () => guest(async () => {
  await addItemToCart({ productId: "p-standard", quantity: 2 });
  for (const method of ["STRIPE", "SSLCOMMERZ", "cod", "", undefined, null]) {
    await assert.rejects(placeOrder({ ...emptyCheckout, paymentMethod: method as never }), /Cash on Delivery/);
  }
  assert.equal(db.rows("order").length, 0);
  assert.equal(stockOf("product", "p-standard"), 5); // untouched
  assert.equal(db.rows("cartItem").length, 1); // cart intact
}));

test("COD order: number format, totals, stock deducted & recorded, cart cleared", () => guest(async () => {
  await addItemToCart({ productId: "p-standard", quantity: 2 });
  const order = await placeOrder(emptyCheckout);
  assert.match(order.orderNumber, /^AP-\d{6}-000001$/);
  assert.equal(order.paymentMethod, "COD");
  assert.equal(order.paymentStatus, "UNPAID");
  assert.equal(Number(order.subtotal), 3600);
  assert.equal(Number(order.total), 3670); // + Dhaka delivery 70
  assert.equal(stockOf("product", "p-standard"), 3);
  const [item] = db.rows("orderItem");
  assert.equal(item.stockDeducted, 2);
  assert.equal(item.stockRestoredAt, null);
  assert.equal(db.rows("cartItem").length, 0);
  assert.equal(db.rows("orderTrackingEvent").length, 1);
}));

test("VARIANT order deducts the variant's stock, not the product's", () => guest(async () => {
  await addItemToCart({ productId: "p-variant", variantId: "v-red", quantity: 2 });
  await placeOrder(emptyCheckout);
  assert.equal(stockOf("productVariant", "v-red"), 1);
  assert.equal(stockOf("product", "p-variant"), 999);
  assert.equal(db.rows("orderItem")[0].variantId, "v-red");
}));

test("checkout re-validates stock authoritatively (cart said yes, stock changed)", () => guest(async () => {
  await addItemToCart({ productId: "p-variant", variantId: "v-red", quantity: 3 });
  await db.productVariant.update({ where: { id: "v-red" }, data: { stock: 1 } });
  await assert.rejects(placeOrder(emptyCheckout), /only has 1|out of stock/i);
  assert.equal(db.rows("order").length, 0);
  assert.equal(stockOf("productVariant", "v-red"), 1);
}));

test("stale cart lines are rejected: inactive product, variant product with no variant, tampered customization", () => guest(async () => {
  await addItemToCart({ productId: "p-standard", quantity: 1 });
  await db.product.update({ where: { id: "p-standard" }, data: { status: "ARCHIVED" } });
  await assert.rejects(placeOrder(emptyCheckout), /no longer available/);
  await db.product.update({ where: { id: "p-standard" }, data: { status: "ACTIVE" } });

  // variant deleted after being added => line has variantId null on a VARIANT product
  const cart = await addItemToCart({ productId: "p-variant", variantId: "v-red", quantity: 1 });
  await db.cartItem.update({ where: { id: cart.items.find((i) => i.variantId)!.id }, data: { variantId: null } });
  await assert.rejects(placeOrder(emptyCheckout), /selected option/);

  // forged quantity / customization written straight into the cart table
  await db.cartItem.deleteMany({ where: {} });
  const cart2 = await addItemToCart({ productId: "p-pers", quantity: 1, customization: { name: "Ann" } });
  await db.cartItem.update({ where: { id: cart2.items[0].id }, data: { customization: { name: "Ann", evil: "<img>" } } });
  await assert.rejects(placeOrder(emptyCheckout), /personalization/i);
  await db.cartItem.update({ where: { id: cart2.items[0].id }, data: { customization: { name: "Ann" }, quantity: -4 } });
  await assert.rejects(placeOrder(emptyCheckout), /quantity/i);
  assert.equal(db.rows("order").length, 0);
}));

test("two shoppers race for the LAST unit: exactly one wins, stock never negative", async () => {
  db.insert("product", { id: "p-last", name: "Last One", slug: "last", status: "ACTIVE", type: "STANDARD", price: 100, stock: 1 });
  for (const who of ["u1", "u2"]) {
    await runAs({ sub: who }, () => addItemToCart({ productId: "p-last", quantity: 1 }));
  }
  const results = await Promise.allSettled(
    ["u1", "u2"].map((who) => runAs({ sub: who }, () => placeOrder({ ...emptyCheckout }))),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason.message), /sold out|only has|out of stock/i);
  assert.equal(stockOf("product", "p-last"), 0);
  assert.equal(db.rows("order").length, 1); // the loser's order rolled back completely
  assert.equal(db.rows("orderItem").length, 1);
});

test("the atomic guard itself holds under interleaving (no transaction mutex)", async () => {
  const { deductStockForLine } = await import("@/server/services/order-inventory");
  db.insert("product", { id: "p-g", name: "G", slug: "g", status: "ACTIVE", price: 1, stock: 3 });
  const line = { productId: "p-g", variantId: null, quantity: 1, productName: "G", trackInventory: true, allowBackorder: false };
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => deductStockForLine(db as never, line)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(stockOf("product", "p-g"), 0);
});

test("60 concurrent orders by different customers get 60 distinct, well-formed order numbers", async () => {
  db.insert("product", { id: "p-bulk", name: "Bulk", slug: "bulk", status: "ACTIVE", type: "STANDARD", price: 10, stock: 1000 });
  const users = Array.from({ length: 60 }, (_, i) => `u${i}`);
  await Promise.all(users.map((u) => runAs({ sub: u }, () => addItemToCart({ productId: "p-bulk", quantity: 1 }))));
  const orders = await Promise.all(users.map((u) => runAs({ sub: u }, () => placeOrder(emptyCheckout))));
  const numbers = orders.map((o) => o.orderNumber);
  assert.equal(new Set(numbers).size, 60);
  for (const n of numbers) assert.match(n, /^AP-\d{6}-\d{6}$/);
  assert.equal(stockOf("product", "p-bulk"), 940);
});

test("double-submit of the SAME cart creates one order and deducts once", async () => {
  await runAs({ sub: "dbl" }, () => addItemToCart({ productId: "p-standard", quantity: 2 }));
  const results = await Promise.allSettled([
    runAs({ sub: "dbl" }, () => placeOrder(emptyCheckout)),
    runAs({ sub: "dbl" }, () => placeOrder(emptyCheckout)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(db.rows("order").length, 1);
  assert.equal(stockOf("product", "p-standard"), 3);
});

test("a duplicate order number is rejected by the unique backstop (P2002)", () => {
  db.insert("order", { id: "o1", orderNumber: "AP-202610-000001" });
  assert.throws(() => db.insert("order", { id: "o2", orderNumber: "AP-202610-000001" }), /Unique constraint/);
});

test("untracked products are never deducted (stockDeducted = 0)", () => guest(async () => {
  db.insert("product", { id: "p-mto", name: "Made to order", slug: "mto", status: "ACTIVE", type: "STANDARD", price: 50, stock: 0, trackInventory: false });
  await addItemToCart({ productId: "p-mto", quantity: 4 });
  await placeOrder(emptyCheckout);
  assert.equal(stockOf("product", "p-mto"), 0);
  assert.equal(db.rows("orderItem")[0].stockDeducted, 0);
}));

test("BUNDLE inventory model: the bundle's OWN stock is consumed; component stock is untouched", () => guest(async () => {
  assert.equal(stockOf("product", "p-standard"), 5); // component of the bundle (qty 2)
  await addItemToCart({ productId: "p-bundle", quantity: 2 });
  await placeOrder(emptyCheckout);
  assert.equal(stockOf("product", "p-bundle"), 0);
  assert.equal(stockOf("product", "p-standard"), 5);
  await assert.rejects(addItemToCart({ productId: "p-bundle", quantity: 1 }), /out of stock/i);
}));

test("coupon usage limit can't be exceeded (conditional increment) and failure rolls back stock", async () => {
  db.insert("coupon", { id: "c1", code: "ONCE", type: "FIXED", value: 100, usageLimit: 1, usageCount: 0, isActive: true });
  db.insert("product", { id: "p-c", name: "C", slug: "c", status: "ACTIVE", type: "STANDARD", price: 1000, stock: 10 });
  for (const u of ["a", "b"]) await runAs({ sub: u }, () => addItemToCart({ productId: "p-c", quantity: 1 }));
  const results = await Promise.allSettled(
    ["a", "b"].map((u) => runAs({ sub: u }, () => placeOrder({ ...emptyCheckout, couponCode: "ONCE" }))),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(db.get("coupon", "c1").usageCount, 1);
  assert.equal(stockOf("product", "p-c"), 9); // the loser's deduction was rolled back
});
