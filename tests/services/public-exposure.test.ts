import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { FORBIDDEN_PUBLIC_PRODUCT_KEYS } from "@/lib/product-dto";
import * as products from "@/server/services/product.service";
import { runAs } from "../setup/helpers";
import { getWishlistWithProducts } from "@/server/services/wishlist.service";
import { getProductForQuickView, getProductsForIds } from "@/server/actions/product.actions";

let db: FakeDb;
beforeEach(() => {
  db = freshDb();
  seedCatalog(db);
  db.insert("productImage", { id: "i1", productId: "p-bundle", url: "https://x/b.png", isMain: true, altText: "b" });
  db.insert("productImage", { id: "i2", productId: "p-standard", url: "https://x/s.png", isMain: true, cloudinaryPublicId: "giftpacific/secret" });
  db.insert("user", { id: "u1", name: "Nusrat Jahan Khan", email: "n@example.com", passwordHash: "HASH" });
  db.insert("review", { id: "r1", productId: "p-standard", userId: "u1", rating: 5, title: "Great", body: "Love it", isApproved: true, status: "APPROVED", createdAt: new Date() });
  db.insert("category", { id: "c1", name: "Clay", slug: "clay", isActive: true });
  db.tables.product.find((p) => p.id === "p-standard")!.categoryId = "c1";
});

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object" && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}
const assertClean = (value: unknown, label: string) => {
  const keys = keysOf(value);
  for (const f of FORBIDDEN_PUBLIC_PRODUCT_KEYS) assert.ok(!keys.has(f), `${label} leaked ${f}`);
  const json = JSON.stringify(value);
  for (const w of ["costPrice", "cloudinary", "secret", "MUG-R", "passwordHash"]) assert.ok(!json.includes(w), `${label} leaked ${w}`);
};

test("getProductBySlug / getProductForQuickView / getProductsForIds expose only the public DTO", async () => {
  // NOTE: the fake DB ignores `select`, so it returns FULL rows (incl. costPrice, sku, stock).
  // The mapper boundary must strip them regardless — this is the defence-in-depth guarantee.
  for (const slug of ["clay-vase", "clay-mug", "couple-frame", "gift-box"]) {
    const data = await products.getProductBySlug(slug);
    assert.ok(data, slug);
    assertClean(data.product, `PDP ${slug}`);
  }
  for (const id of ["p-standard", "p-variant", "p-pers", "p-bundle"]) {
    assertClean(await getProductForQuickView(id), `QuickView ${id}`);
  }
  assertClean(await getProductsForIds(["p-standard", "p-variant", "p-pers", "p-bundle"]), "recently viewed");
  assertClean(await products.listProducts({}), "listing");
  assertClean(await products.getFeaturedProducts(), "featured");
});

test("variants and bundle components in the public detail carry only what the UI needs", async () => {
  const mug = (await products.getProductBySlug("clay-mug"))!.product;
  assert.deepEqual(Object.keys(mug.variants[0]).sort(), ["id", "image", "inStock", "isDefault", "maxQuantity", "name", "options", "price"]);
  const box = (await products.getProductBySlug("gift-box"))!.product;
  assert.deepEqual(box.bundleComponents, [{ name: "Clay Vase", quantity: 2, imageUrl: "https://x/s.png" }]);
  const pers = (await products.getProductBySlug("couple-frame"))!.product;
  assert.deepEqual(Object.keys(pers.customizationFields[0]).sort(), ["fieldKey", "isRequired", "label", "maxLength", "options", "type"]);
});

test("reviews expose a short reviewer name only — no email, no hash, no full name", async () => {
  const data = (await products.getProductBySlug("clay-vase"))!;
  assert.equal(data.reviews.length, 1);
  assert.equal(data.reviews[0].reviewerName, "Nusrat K.");
  const json = JSON.stringify(data.reviews);
  for (const w of ["HASH", "n@example.com", "Jahan", "passwordHash", "email"]) assert.ok(!json.includes(w), w);
});

test("the page-level wrapper keeps categoryId OUT of the product object passed to clients", async () => {
  const data = (await products.getProductBySlug("clay-vase"))!;
  assert.equal(data.categoryId, "c1");
  assert.ok(!("categoryId" in data.product));
});

test("variant availability is correct on every surface (detail, card, listing, in-stock filter)", async () => {
  const mug = (await products.getProductBySlug("clay-mug"))!.product;
  assert.equal(mug.availability.inStock, true); // v-red has stock 3
  assert.deepEqual(mug.variants.map((v) => [v.id, v.inStock]).sort(), [["v-blue", false], ["v-red", true]]);
  const qv = (await getProductForQuickView("p-variant"))!;
  assert.equal(qv.availability.inStock, true);

  // sell out the only purchasable variant: product-level stock 999 must NOT keep it "in stock"
  await db.productVariant.update({ where: { id: "v-red" }, data: { stock: 0 } });
  assert.equal((await products.getProductBySlug("clay-mug"))!.product.availability.inStock, false);
  const listing = await products.listProducts({});
  assert.equal(listing.items.find((p) => p.id === "p-variant")!.availability.inStock, false);
  const inStockOnly = await products.listProducts({ inStockOnly: true });
  assert.ok(!inStockOnly.items.some((p) => p.id === "p-variant"));
  assert.ok(inStockOnly.items.some((p) => p.id === "p-standard"));
  // restock one variant: it reappears
  await db.productVariant.update({ where: { id: "v-blue" }, data: { stock: 2 } });
  assert.ok((await products.listProducts({ inStockOnly: true })).items.some((p) => p.id === "p-variant"));
  // search surface (listProducts with search) uses the same availability
  const found = await products.listProducts({ search: "mug" });
  assert.equal(found.items[0].availability.inStock, true);
});

test("listing params from the query string are sanitized (NaN / junk never reach the database)", async () => {
  const res = await products.listProducts({ page: NaN, pageSize: -5, minPrice: NaN, maxPrice: "abc" as never, sort: "evil" as never });
  assert.equal(res.page, 1);
  assert.ok(res.items.length > 0);
});

test("inactive products are never returned", async () => {
  await db.product.update({ where: { id: "p-standard" }, data: { status: "DRAFT" } });
  assert.equal(await products.getProductBySlug("clay-vase"), null);
  assert.equal(await getProductForQuickView("p-standard"), null);
  assert.ok(!(await getProductsForIds(["p-standard"])).length);
});

test("wishlist data handed to the client component is the public card DTO (no costPrice/stock spread)", async () => {
  db.insert("wishlist", { id: "w1", userId: "u1" });
  db.insert("wishlistItem", { id: "wi1", wishlistId: "w1", productId: "p-variant", addedAt: new Date() });
  db.insert("wishlistItem", { id: "wi2", wishlistId: "w1", productId: "p-standard", addedAt: new Date() });
  const items = await runAs({ sub: "u1" }, () => getWishlistWithProducts());
  assert.equal(items.length, 2);
  assertClean(items, "wishlist");
  assert.ok(items.every((i) => typeof i.price === "number" && "availability" in i));
});

import { emptyCheckout } from "../setup/helpers";
import { addItemToCart } from "@/server/services/cart.service";
import { getOrderByNumberForCurrentUser, getOrderForConfirmation, placeOrder } from "@/server/services/order.service";

test("customer-facing order data excludes adminNote, confirmationToken, stock bookkeeping, full coupon/product rows", async () => {
  db.insert("coupon", { id: "cp", code: "HELLO", type: "FIXED", value: 10, usageLimit: 99, usageCount: 0, isActive: true, perUserLimit: 5 });
  await runAs({ sub: "u9" }, () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const placed = await runAs({ sub: "u9" }, () => placeOrder({ ...emptyCheckout, couponCode: "HELLO" }));
  await db.order.update({ where: { id: placed.id }, data: { adminNote: "customer is rude, flag fraud" } });

  const own = await runAs({ sub: "u9" }, () => getOrderByNumberForCurrentUser(placed.orderNumber));
  const token = db.get("order", placed.id).confirmationToken;
  const viaToken = await runAs(null, () => getOrderForConfirmation(placed.orderNumber, token));
  assert.ok(own && viaToken);
  for (const [label, order] of [["account", own], ["confirmation", viaToken]] as const) {
    const json = JSON.stringify(order);
    for (const word of ["adminNote", "fraud", "confirmationToken", token, "costPrice", "unitCost", "comboSnapshot", "createdById", "stockDeducted", "stockRestoredAt", "usageLimit", "perUserLimit", "lowStockThreshold"]) {
      assert.ok(!json.includes(word), `${label} order leaked ${word}`);
    }
    assert.deepEqual(order!.coupon, { code: "HELLO" });
    assert.deepEqual(Object.keys(order!.items[0].product!).sort(), ["images", "slug"]);
    assert.equal(order!.orderNumber, placed.orderNumber);
  }
  // wrong token / other user still can't read it
  assert.equal(await runAs(null, () => getOrderForConfirmation(placed.orderNumber, "wrong")), null);
  assert.equal(await runAs({ sub: "someone-else" }, () => getOrderByNumberForCurrentUser(placed.orderNumber)), null);
});

import { getOrdersForCurrentUser } from "@/server/services/order.service";
test("customer order LIST also excludes staff notes and tokens", async () => {
  await runAs({ sub: "u7" }, () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const placed = await runAs({ sub: "u7" }, () => placeOrder({ ...emptyCheckout }));
  await db.order.update({ where: { id: placed.id }, data: { adminNote: "INTERNAL" } });
  const list = await runAs({ sub: "u7" }, () => getOrdersForCurrentUser());
  assert.equal(list.length, 1);
  const json = JSON.stringify(list);
  for (const w of ["adminNote", "INTERNAL", "confirmationToken", "stockDeducted", "unitCost", "comboSnapshot"]) assert.ok(!json.includes(w), w);
});

test("a combo order shows its contents to the customer but never costs, prices of parts, ids or stock bookkeeping", async () => {
  db.insert("product", { id: "p-box", name: "Heart Box", slug: "heart-box", type: "STANDARD", status: "ACTIVE", price: 200, costPrice: 80, stock: 4, description: "A heart shaped box" });
  db.insert("product", {
    id: "p-custom", name: "Build Your Box", slug: "build-your-box", type: "BUNDLE", status: "ACTIVE", price: 1000, stock: 0, description: "Make your own box",
    kind: "COMBO", comboMode: "CUSTOMIZABLE", comboPricing: "FIXED_PRICE", comboStockPolicy: "COMPONENTS",
  });
  db.insert("comboSlot", { id: "s-box", comboId: "p-custom", label: "Box", minSelect: 1, maxSelect: 1, maxPerOption: 1, sortOrder: 0 });
  db.insert("comboSlotOption", { id: "o-box", slotId: "s-box", productId: "p-box", priceDelta: 0, sortOrder: 0 });
  await runAs({ sub: "u5" }, () => addItemToCart({ productId: "p-custom", quantity: 1, selections: [{ slotId: "s-box", optionId: "o-box", quantity: 1 }] }));
  const placed = await runAs({ sub: "u5" }, () => placeOrder({ ...emptyCheckout }));
  const own = await runAs({ sub: "u5" }, () => getOrderByNumberForCurrentUser(placed.orderNumber));
  assert.deepEqual(own!.items[0].components, [{ slotLabel: "Box", productName: "Heart Box", variantName: null, quantity: 1 }]);
  const json = JSON.stringify(own);
  for (const w of ["unitCost", "comboSnapshot", "stockDeducted", "stockRestoredAt", "stockReturnedQty", "stockDiscardedQty", "procurementQty", "procurementReceivedQty", "trustScore", "trustSnapshot", "advanceWaived", "settlementStatus", "costPrice", "createdById", '"costPrice":80']) assert.ok(!json.includes(w), `leaked ${w}`);
});
