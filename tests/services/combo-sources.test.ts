import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart, getCurrentCartDTO } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import { catalogOptionId, boxOptionId, loadComboTemplates } from "@/server/services/combo.service";
import { prisma } from "@/lib/db/prisma";

// Build-your-own: slots whose choices are rebuilt from live data (any active product / our boxes).
let db: FakeDb;
const guest = <T,>(fn: () => Promise<T>) => runAs(null, fn);
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
const stock = (id: string) => db.get("product", id).stock as number;
const sel = (slotId: string, optionId: string, quantity = 1) => ({ slotId, optionId, quantity });

beforeEach(() => {
  db = freshDb(); seedAdmins(db);
  seedCatalog(db); // p-standard "Clay Vase" 1800 stock 5; p-variant "Clay Mug" v-red 650 (stock 3); p-bundle legacy combo
  db.insert("product", { id: "p-boxprod", name: "Gift Box", slug: "gift-box-product", type: "STANDARD", status: "ACTIVE", price: 250, costPrice: 90, stock: 4, description: "x", isBoxProduct: true });
  db.insert("box", { id: "bx1", name: "Gift Box", slug: "gift-box", price: 250, isActive: true, productId: "p-boxprod" });
  db.insert("box", { id: "bx-off", name: "Hidden Box", slug: "hidden", price: 100, isActive: false, productId: null });
  db.insert("product", {
    id: "p-byo", name: "Nije Combo", slug: "nije-combo", type: "BUNDLE", status: "ACTIVE", price: 0, stock: 0, description: "x",
    kind: "COMBO", comboMode: "CUSTOMIZABLE", comboPricing: "COMPONENT_SUM", comboStockPolicy: "COMPONENTS",
  });
  db.insert("comboSlot", { id: "s-items", comboId: "p-byo", label: "Your items", minSelect: 1, maxSelect: 4, maxPerOption: 2, sortOrder: 0, source: "CATALOG" });
  db.insert("comboSlot", { id: "s-box", comboId: "p-byo", label: "Box (optional)", minSelect: 0, maxSelect: 1, maxPerOption: 1, sortOrder: 1, source: "BOXES" });
});

test("catalog slot offers only ACTIVE single products (variants expanded); boxes slot only active boxes linked to ACTIVE products", async () => {
  db.insert("product", { id: "p-draft", name: "Draft", slug: "draft", type: "STANDARD", status: "DRAFT", price: 10, stock: 9, description: "x" });
  const t = (await loadComboTemplates(prisma, ["p-byo"])).get("p-byo")!;
  const ids = (label: string) => t.slots.find((s) => s.label === label)!.options.map((o) => o.id);
  assert.ok(ids("Your items").includes(catalogOptionId("p-standard", null)));
  assert.ok(ids("Your items").includes(catalogOptionId("p-variant", "v-red")));
  assert.ok(!ids("Your items").some((i) => i.includes("p-draft")));
  assert.ok(!ids("Your items").some((i) => i.includes("p-boxprod"))); // managed box products are offered only through the boxes group
  assert.ok(!ids("Your items").some((i) => i.includes("p-byo") || i.includes("p-bundle"))); // combos are never components
  assert.deepEqual(ids("Box (optional)"), [boxOptionId("bx1")]);
  db.patch("product", "p-boxprod", { status: "DRAFT" });
  const t2 = (await loadComboTemplates(prisma, ["p-byo"])).get("p-byo")!;
  assert.deepEqual(t2.slots.find((s) => s.label === "Box (optional)")!.options, []);
});

test("free choice: price is the server-side sum of CURRENT product prices; stock deducted per component; cancel restores once", () => guest(async () => {
  await addItemToCart({ productId: "p-byo", quantity: 2, selections: [sel("s-items", catalogOptionId("p-standard", null), 2), sel("s-items", catalogOptionId("p-variant", "v-red"), 1), sel("s-box", boxOptionId("bx1"))] });
  const cart = await getCurrentCartDTO();
  assert.equal(cart.items[0].unitPrice, 2 * 1800 + 650 + 250); // no discount invented
  const order = await placeOrder(emptyCheckout);
  assert.equal(stock("p-standard"), 5 - 4);
  assert.equal(stock("p-boxprod"), 4 - 2);
  assert.equal(db.get("productVariant", "v-red").stock, 3 - 2);
  assert.equal(stock("p-byo"), 0);
  assert.equal(db.rows("orderItemComponent").length, 3);
  await admin(() => adminUpdateOrderStatus(order.id, "CANCELLED", undefined, TEST_ADMIN));
  assert.equal(stock("p-standard"), 5);
  assert.equal(stock("p-boxprod"), 4);
  assert.equal(db.get("productVariant", "v-red").stock, 3);
  await assert.rejects(admin(() => adminUpdateOrderStatus(order.id, "CANCELLED", undefined, TEST_ADMIN)));
  assert.equal(stock("p-standard"), 5);
}));

test("server rejects: per-product limit, group maximum, forged ids, inactive products, a second box", () => guest(async () => {
  const vase = catalogOptionId("p-standard", null);
  await assert.rejects(addItemToCart({ productId: "p-byo", quantity: 1, selections: [sel("s-items", vase, 3)] }), /at most 2/);
  await assert.rejects(addItemToCart({ productId: "p-byo", quantity: 1, selections: [sel("s-items", "c:does-not-exist")] }), /not available/);
  await assert.rejects(addItemToCart({ productId: "p-byo", quantity: 1, selections: [sel("s-box", boxOptionId("bx-off")), sel("s-items", vase)] }), /not available/);
  await assert.rejects(addItemToCart({ productId: "p-byo", quantity: 1, selections: [sel("s-items", vase), sel("s-box", boxOptionId("bx1"), 2)] }), /at most/);
  await assert.rejects(addItemToCart({ productId: "p-byo", quantity: 1, selections: [] }), /Please choose/);
  db.patch("product", "p-standard", { status: "DRAFT" });
  await assert.rejects(addItemToCart({ productId: "p-byo", quantity: 1, selections: [sel("s-items", vase)] }), /not available/);
  assert.equal(db.rows("orderItem").length, 0);
}));

test("a box is optional; without it the price excludes it; last-unit race cannot oversell", () => guest(async () => {
  const mug = catalogOptionId("p-variant", "v-red");
  await addItemToCart({ productId: "p-byo", quantity: 1, selections: [sel("s-items", mug, 2)] });
  assert.equal((await getCurrentCartDTO()).items[0].unitPrice, 1300);
  // The cart refuses a second combo that would need 4 of the 3 red mugs...
  await assert.rejects(addItemToCart({ productId: "p-byo", quantity: 1, selections: [sel("s-items", mug, 2)] }));
  // ...and if stock is taken by someone else AFTER the cart was filled, checkout must refuse and leave everything untouched.
  db.patch("productVariant", "v-red", { stock: 1 });
  await assert.rejects(placeOrder(emptyCheckout));
  assert.equal(db.get("productVariant", "v-red").stock, 1);
  assert.equal(db.rows("order").length, 0);
}));
