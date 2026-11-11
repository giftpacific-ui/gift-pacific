import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getProductAvailability,
  isValidQuantity,
  MAX_QUANTITY_PER_LINE,
  resolveLineStock,
  totalQuantityFor,
  validateVariantSelection,
  type ProductTypeName,
} from "@/lib/stock";
import { inStockWhere } from "@/lib/product-queries";
import { freshDb } from "../setup/helpers";

const base = { stock: 0, allowBackorder: false, trackInventory: true };

test("STANDARD uses product-level stock", () => {
  assert.equal(getProductAvailability({ ...base, type: "STANDARD", stock: 3 }).inStock, true);
  assert.equal(getProductAvailability({ ...base, type: "STANDARD", stock: 0 }).inStock, false);
  assert.equal(getProductAvailability({ ...base, type: "STANDARD", stock: 0, allowBackorder: true }).inStock, true);
  assert.equal(getProductAvailability({ ...base, type: "STANDARD", stock: 0, trackInventory: false }).inStock, true);
});

test("VARIANT product ignores product-level stock: no purchasable variant => out of stock", () => {
  // The bug: product.stock=999 made a variant product with zero variant stock look "in stock".
  const none = getProductAvailability({ ...base, type: "VARIANT", stock: 999, variants: [] });
  assert.deepEqual(none, { inStock: false, maxQuantity: 0 });
  const allZero = getProductAvailability({
    ...base, type: "VARIANT", stock: 999,
    variants: [{ stock: 0, allowBackorder: false }, { stock: 0, allowBackorder: false }],
  });
  assert.equal(allZero.inStock, false);
});

test("VARIANT product with one purchasable variant is in stock", () => {
  const a = getProductAvailability({
    ...base, type: "VARIANT", stock: 0,
    variants: [{ stock: 0, allowBackorder: false }, { stock: 4, allowBackorder: false }],
  });
  assert.deepEqual(a, { inStock: true, maxQuantity: 4 });
  const backorder = getProductAvailability({
    ...base, type: "VARIANT", variants: [{ stock: 0, allowBackorder: true }],
  });
  assert.deepEqual(backorder, { inStock: true, maxQuantity: null });
  const untracked = getProductAvailability({
    ...base, trackInventory: false, type: "VARIANT", variants: [{ stock: 0, allowBackorder: false }],
  });
  assert.equal(untracked.inStock, true);
  // untracked but NO variants is still unpurchasable
  assert.equal(getProductAvailability({ ...base, trackInventory: false, type: "VARIANT", variants: [] }).inStock, false);
});

test("BUNDLE availability is its own independent stock", () => {
  assert.equal(getProductAvailability({ ...base, type: "BUNDLE", stock: 2 }).inStock, true);
  assert.equal(getProductAvailability({ ...base, type: "BUNDLE", stock: 0 }).inStock, false);
});

test("quantity validation", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, "2", null, undefined, MAX_QUANTITY_PER_LINE + 1]) {
    assert.equal(isValidQuantity(bad), false, String(bad));
  }
  assert.equal(isValidQuantity(1), true);
  assert.equal(isValidQuantity(MAX_QUANTITY_PER_LINE), true);
});

test("variant selection rules", () => {
  const v = (productType: ProductTypeName, variantId: string | null, ok: boolean) =>
    validateVariantSelection({ productType, variantId, variantBelongsToProduct: ok });
  assert.notEqual(v("VARIANT", null, false), null); // must choose an option
  assert.notEqual(v("VARIANT", "x", false), null); // foreign variant
  assert.equal(v("VARIANT", "x", true), null);
  assert.notEqual(v("STANDARD", "x", true), null); // non-variant product can't carry a variant
  assert.equal(v("STANDARD", null, false), null);
});

test("line stock resolves to the variant's fields for variant lines", () => {
  const r = resolveLineStock({
    trackInventory: true,
    product: { stock: 999, allowBackorder: true, procurementPending: 40, procurementLimit: 100 },
    variant: { stock: 2, allowBackorder: false, procurementPending: 1, procurementLimit: 3 },
  });
  // every field (including the procurement ones) comes from the VARIANT, never mixed with the product's
  assert.deepEqual(r, { stock: 2, allowBackorder: false, procurementPending: 1, procurementLimit: 3, trackInventory: true });
  assert.equal(totalQuantityFor([{ productId: "a", variantId: null, quantity: 2 }, { productId: "a", variantId: null, quantity: 3 }, { productId: "b", variantId: null, quantity: 9 }], "a", null), 5);
});

test("DB in-stock filter agrees with getProductAvailability over a grid of products", async () => {
  const db = freshDb();
  const types: ProductTypeName[] = ["STANDARD", "VARIANT", "PERSONALIZED", "BUNDLE"];
  const cases: { id: string; type: ProductTypeName; stock: number; allowBackorder: boolean; trackInventory: boolean; variants: { stock: number; allowBackorder: boolean }[] }[] = [];
  let n = 0;
  const variantSets = [[], [{ stock: 0, allowBackorder: false }], [{ stock: 2, allowBackorder: false }], [{ stock: 0, allowBackorder: true }], [{ stock: 0, allowBackorder: false }, { stock: 1, allowBackorder: false }]];
  for (const type of types) for (const stock of [0, 5]) for (const allowBackorder of [false, true]) for (const trackInventory of [false, true]) {
    for (const variants of type === "VARIANT" ? variantSets : [[]]) {
      const id = `c${++n}`;
      cases.push({ id, type, stock, allowBackorder, trackInventory, variants });
      db.insert("product", { id, type, stock, allowBackorder, trackInventory, status: "ACTIVE", slug: id });
      variants.forEach((v, i) => db.insert("productVariant", { id: `${id}-v${i}`, productId: id, sku: `${id}-${i}`, ...v }));
    }
  }
  const inStockIds = new Set((await db.product.findMany({ where: inStockWhere() })).map((p: { id: string }) => p.id));
  for (const c of cases) {
    const expected = getProductAvailability(c).inStock;
    assert.equal(inStockIds.has(c.id), expected, JSON.stringify(c));
  }
  assert.ok(cases.length > 60);
});
