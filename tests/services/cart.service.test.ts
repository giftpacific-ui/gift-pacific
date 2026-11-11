import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import {
  addItemToCart,
  getCurrentCartDTO,
  updateCartItemQuantity,
} from "@/server/services/cart.service";

let db: FakeDb;
beforeEach(() => {
  db = freshDb();
  seedCatalog(db);
});
const guest = <T>(fn: () => Promise<T>) => runAs(null, fn);
const rejects = (p: Promise<unknown>, re?: RegExp) =>
  assert.rejects(p, re ?? /./);

test("quantity must be a positive whole number within the cap", () =>
  guest(async () => {
    for (const q of [0, -3, 1.5, NaN, 100, 1e9]) {
      await rejects(addItemToCart({ productId: "p-standard", quantity: q }));
    }
    assert.equal(db.rows("cartItem").length, 0);
  }));

test("VARIANT product: a variant is required, foreign/other-type variants are rejected", () =>
  guest(async () => {
    await rejects(
      addItemToCart({ productId: "p-variant", quantity: 1 }),
      /option/i,
    );
    await rejects(
      addItemToCart({ productId: "p-variant", variantId: "nope", quantity: 1 }),
    );
    // a variant that belongs to ANOTHER product
    db.insert("productVariant", {
      id: "v-other",
      productId: "p-standard",
      sku: "X",
      price: 1,
      stock: 5,
      options: { A: "b" },
    });
    await rejects(
      addItemToCart({
        productId: "p-variant",
        variantId: "v-other",
        quantity: 1,
      }),
    );
    // a non-variant product can't carry a variant
    await rejects(
      addItemToCart({
        productId: "p-standard",
        variantId: "v-red",
        quantity: 1,
      }),
    );
    assert.equal(db.rows("cartItem").length, 0);
  }));

test("VARIANT stock is the VARIANT's stock — product.stock=999 is ignored", () =>
  guest(async () => {
    await rejects(
      addItemToCart({
        productId: "p-variant",
        variantId: "v-blue",
        quantity: 1,
      }),
      /out of stock/i,
    ); // v-blue stock 0
    await rejects(
      addItemToCart({
        productId: "p-variant",
        variantId: "v-red",
        quantity: 4,
      }),
      /only 3/i,
    ); // v-red stock 3
    const cart = await addItemToCart({
      productId: "p-variant",
      variantId: "v-red",
      quantity: 3,
    });
    assert.equal(cart.items[0].quantity, 3);
    assert.equal(cart.items[0].inStock, true);
    assert.equal(cart.items[0].maxQuantity, 3);
    await rejects(
      addItemToCart({
        productId: "p-variant",
        variantId: "v-red",
        quantity: 1,
      }),
      /only 3/i,
    ); // already 3 in cart
  }));

test("cart DTO exposes availability, not raw inventory fields", () =>
  guest(async () => {
    const cart = await addItemToCart({ productId: "p-standard", quantity: 1 });
    const keys = Object.keys(cart.items[0]);
    for (const k of ["stock", "allowBackorder", "trackInventory", "costPrice"])
      assert.ok(!keys.includes(k), k);
    assert.ok(keys.includes("inStock") && keys.includes("maxQuantity"));
  }));

test("inactive / unknown products can't be added", () =>
  guest(async () => {
    db.insert("product", {
      id: "p-draft",
      name: "D",
      slug: "d",
      status: "DRAFT",
      stock: 5,
      price: 10,
    });
    await rejects(addItemToCart({ productId: "p-draft", quantity: 1 }));
    await rejects(addItemToCart({ productId: "ghost", quantity: 1 }));
  }));

test("personalization is validated server-side; personalized lines never merge", () =>
  guest(async () => {
    await rejects(
      addItemToCart({ productId: "p-pers", quantity: 1 }),
      /required/i,
    ); // name required
    await rejects(
      addItemToCart({
        productId: "p-pers",
        quantity: 1,
        customization: { name: "WayTooLongName" },
      }),
    );
    await rejects(
      addItemToCart({
        productId: "p-pers",
        quantity: 1,
        customization: { name: "Ann", hack: "x" },
      }),
    );
    await rejects(
      addItemToCart({
        productId: "p-pers",
        quantity: 1,
        customization: { name: "Ann", color: "Pink" },
      }),
    );
    await rejects(
      addItemToCart({
        productId: "p-standard",
        quantity: 1,
        customization: { name: "x" },
      }),
    );
    await addItemToCart({
      productId: "p-pers",
      quantity: 1,
      customization: { name: "Ann", color: "Gold" },
    });
    const cart = await addItemToCart({
      productId: "p-pers",
      quantity: 1,
      customization: { name: "Ann", color: "Gold" },
    });
    assert.equal(cart.items.length, 2);
    assert.deepEqual(cart.items[0].customization, {
      name: "Ann",
      color: "Gold",
    });
  }));

test("plain adds merge; stock counts ALL lines of the same product together", () =>
  guest(async () => {
    await addItemToCart({ productId: "p-standard", quantity: 2 });
    const cart = await addItemToCart({ productId: "p-standard", quantity: 3 });
    assert.equal(cart.items.length, 1);
    assert.equal(cart.items[0].quantity, 5);
    await rejects(
      addItemToCart({ productId: "p-standard", quantity: 1 }),
      /only 5|out of stock/i,
    );
    // personalized product stock=10: two lines of 6 exceed the shared pool
    await addItemToCart({
      productId: "p-pers",
      quantity: 6,
      customization: { name: "A" },
    });
    await rejects(
      addItemToCart({
        productId: "p-pers",
        quantity: 6,
        customization: { name: "B" },
      }),
      /only 10/i,
    );
  }));

test("update quantity: validated and stock-checked against the variant", () =>
  guest(async () => {
    const cart = await addItemToCart({
      productId: "p-variant",
      variantId: "v-red",
      quantity: 1,
    });
    const id = cart.items[0].id;
    await rejects(updateCartItemQuantity(id, 4), /only 3/i);
    await rejects(updateCartItemQuantity(id, 1.5));
    await rejects(updateCartItemQuantity(id, 100));
    assert.equal((await updateCartItemQuantity(id, 3)).items[0].quantity, 3);
    assert.equal((await updateCartItemQuantity(id, 0)).items.length, 0);
    assert.equal((await getCurrentCartDTO()).items.length, 0);
  }));
