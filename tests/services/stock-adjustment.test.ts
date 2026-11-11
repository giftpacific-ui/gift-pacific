import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { adjustStock, listStockAdjustments } from "@/server/services/stock-adjustment.service";
import { adjustStockAction } from "@/server/actions/admin-stock.actions";
import { saveProductAction, saveVariantAction } from "@/server/actions/admin-product.actions";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import { validateAdjustment } from "@/lib/stock-adjustment";

let db: FakeDb;
beforeEach(() => { db = freshDb(); seedAdmins(db); seedCatalog(db); });
const stock = (t: string, id: string) => db.get(t, id).stock as number;
const ledger = () => db.rows("stockAdjustment");
/** Manual history only (what an admin typed). Order, incident and procurement movements are in the same ledger under their own `kind`. */
const hist = () => ledger().filter((r) => r.kind === "MANUAL_ADJUSTMENT");

test("adjusting records delta, resulting stock, reason and who did it", async () => {
  const r = await adjustStock({ productId: "p-standard", delta: 7, reason: "  Restock   from supplier ", adminId: "admin-1" });
  assert.equal(r.stockAfter, 12);
  assert.equal(stock("product", "p-standard"), 12);
  await adjustStock({ productId: "p-standard", delta: -2, reason: "Damaged in storage", adminId: "admin-1" });
  assert.deepEqual(hist().map((h) => [h.delta, h.stockAfter, h.reason, h.createdById]), [[7, 12, "Restock from supplier", "admin-1"], [-2, 10, "Damaged in storage", "admin-1"]]);
  const list = await listStockAdjustments("p-standard");
  assert.equal(list.length, 2);
});

test("cannot remove more than is on hand; nothing changes and nothing is logged", async () => {
  await assert.rejects(adjustStock({ productId: "p-standard", delta: -6, reason: "recount", adminId: "a1" }), /Not enough stock/);
  assert.equal(stock("product", "p-standard"), 5);
  assert.equal(hist().length, 0);
});

test("concurrent removals never take stock below zero (guarded atomic update)", async () => {
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => adjustStock({ productId: "p-standard", delta: -1, reason: "sold offline", adminId: "a1" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(stock("product", "p-standard"), 0);
  assert.equal(hist().length, 5);
});

test("variant products: a variant is required, must belong to the product, others must not carry one", async () => {
  await assert.rejects(adjustStock({ productId: "p-variant", delta: 1, reason: "restock", adminId: "a1" }), /Choose which variant/);
  await assert.rejects(adjustStock({ productId: "p-variant", variantId: "nope", delta: 1, reason: "restock", adminId: "a1" }), /not found for this product/);
  db.insert("productVariant", { id: "v-foreign", productId: "p-standard", sku: "F", price: 1, stock: 5, options: { A: "b" } });
  await assert.rejects(adjustStock({ productId: "p-variant", variantId: "v-foreign", delta: 1, reason: "restock", adminId: "a1" }), /not found for this product/);
  await assert.rejects(adjustStock({ productId: "p-standard", variantId: "v-red", delta: 1, reason: "restock", adminId: "a1" }), /no variants/);
  assert.equal(stock("productVariant", "v-foreign"), 5);
  await adjustStock({ productId: "p-variant", variantId: "v-blue", delta: 4, reason: "restock", adminId: "a1" });
  assert.equal(stock("productVariant", "v-blue"), 4);
  assert.equal(stock("product", "p-variant"), 999); // product-level stock untouched
  assert.equal(hist()[0].variantId, "v-blue");
});

test("input validation", () => {
  for (const delta of [0, 1.5, NaN, 1e9, "3", null]) assert.equal(validateAdjustment({ delta, reason: "valid reason" }).ok, false, String(delta));
  for (const reason of ["", "  ", "ab", "x".repeat(201), null, 5]) assert.equal(validateAdjustment({ delta: 1, reason }).ok, false, String(reason));
  assert.equal(validateAdjustment({ delta: -3, reason: "recount" }).ok, true);
});

test("the action is admin-only and returns safe errors", async () => {
  await assert.rejects(runAs(null, () => adjustStockAction("p-standard", null, 1, "restock")), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "cust" }, () => adjustStockAction("p-standard", null, 1, "restock")), /FORBIDDEN/);
  const bad = await runAs("admin", () => adjustStockAction("p-standard", null, -99, "recount"));
  assert.equal(bad.success, false);
  const ok = await runAs("admin", () => adjustStockAction("p-standard", null, 3, "restock"));
  assert.deepEqual([ok.success, ok.success && ok.stockAfter], [true, 8]);
  assert.equal(hist()[0].createdById, "admin-1");
});

const form = (o = {}) => ({
  name: "Clay Vase", slug: "clay-vase", shortDescription: "", description: "A vase for flowers", sku: "", brand: "", type: "STANDARD", status: "ACTIVE", badges: [],
  categoryId: "", price: 1800, compareAtPrice: "", costPrice: 700, stock: 5, loadedStock: 5, lowStockThreshold: 5, allowBackorder: false, trackInventory: true,
  isFeatured: false, videoUrl: "", weightGrams: "", metaTitle: "", metaDescription: "", ...o,
});

test("a STALE product form can no longer overwrite live stock (lost-update fix)", async () => {
  // admin opens the form (stock 5)… meanwhile an order takes 2 units
  await runAs({ sub: "c" }, () => addItemToCart({ productId: "p-standard", quantity: 2 }));
  await runAs({ sub: "c" }, () => placeOrder(emptyCheckout));
  assert.equal(stock("product", "p-standard"), 3);
  // …admin edits the description and saves; the form still says stock 5
  const res = await runAs("admin", () => saveProductAction("p-standard", form({ description: "New description" })));
  assert.equal(res.success, true);
  assert.equal(db.get("product", "p-standard").description, "New description");
  assert.equal(stock("product", "p-standard"), 3); // NOT reset to 5
  assert.equal(hist().length, 0);
});

test("editing the stock field applies only the admin's change, relative to live stock, with history", async () => {
  await runAs({ sub: "c" }, () => addItemToCart({ productId: "p-standard", quantity: 2 }));
  await runAs({ sub: "c" }, () => placeOrder(emptyCheckout)); // live = 3
  const res = await runAs("admin", () => saveProductAction("p-standard", form({ stock: 8 }))); // 5 -> 8 = +3
  assert.equal(res.success, true);
  assert.equal(stock("product", "p-standard"), 6); // 3 + 3, order's deduction preserved
  assert.deepEqual(hist().map((h) => [h.delta, h.stockAfter, h.reason]), [[3, 6, "Edited in product form"]]);
});

test("a form edit that would go below zero is rejected as a whole (nothing partially saved)", async () => {
  await runAs({ sub: "c" }, () => addItemToCart({ productId: "p-standard", quantity: 3 }));
  await runAs({ sub: "c" }, () => placeOrder(emptyCheckout)); // live = 2
  const res = await runAs("admin", () => saveProductAction("p-standard", form({ name: "Renamed", stock: 0 }))); // -5 vs live 2
  assert.equal(res.success, false);
  assert.equal(db.get("product", "p-standard").name, "Clay Vase");
  assert.equal(stock("product", "p-standard"), 2);
  assert.equal(hist().length, 0);
});

const variantForm = (o = {}) => ({ name: "Red", sku: "MUG-R", price: 650, optionsJson: '{"Color":"Red"}', stock: 3, loadedStock: 3, image: "", allowBackorder: false, isDefault: false, ...o });

test("variant form: stale value can't overwrite; real edits are relative and logged", async () => {
  await runAs({ sub: "c" }, () => addItemToCart({ productId: "p-variant", variantId: "v-red", quantity: 2 }));
  await runAs({ sub: "c" }, () => placeOrder(emptyCheckout)); // v-red 3 -> 1
  assert.equal((await runAs("admin", () => saveVariantAction("p-variant", "v-red", variantForm({ price: 700 })))).success, true);
  assert.equal(stock("productVariant", "v-red"), 1);
  assert.equal(db.get("productVariant", "v-red").price, 700);
  assert.equal(hist().length, 0);
  assert.equal((await runAs("admin", () => saveVariantAction("p-variant", "v-red", variantForm({ stock: 10 })))).success, true); // +7
  assert.equal(stock("productVariant", "v-red"), 8);
  assert.deepEqual([hist()[0].delta, hist()[0].variantId, hist()[0].reason], [7, "v-red", "Edited in variant form"]);
  // creating a variant doesn't leak the form-only field into the database row
  const created = await runAs("admin", () => saveVariantAction("p-variant", null, variantForm({ sku: "MUG-G", optionsJson: '{"Color":"Green"}', loadedStock: undefined, stock: 4 })));
  assert.equal(created.success, true);
  assert.ok(!("loadedStock" in db.rows("productVariant").find((v) => v.sku === "MUG-G")!));
});

test("order placement and release are in the ledger with their reason and source record, exactly once each; they are not manual history", async () => {
  await runAs({ sub: "c" }, () => addItemToCart({ productId: "p-standard", quantity: 2 }));
  const o = await runAs({ sub: "c" }, () => placeOrder(emptyCheckout));
  const line = db.rows("orderItem")[0];
  assert.deepEqual(ledger().map((r) => [r.kind, r.delta, r.stockAfter, r.sourceType, r.sourceId, r.idempotencyKey]), [["ORDER_PLACED", -2, 3, "ORDER_ITEM", line.id, `PLACE:${line.id}`]]);
  await adminUpdateOrderStatus(o.id, "CANCELLED", undefined, TEST_ADMIN);
  assert.equal(stock("product", "p-standard"), 5);
  assert.deepEqual(ledger().map((r) => [r.kind, r.delta, r.stockAfter, r.idempotencyKey]), [["ORDER_PLACED", -2, 3, `PLACE:${line.id}`], ["ORDER_RELEASED", 2, 5, `RELEASE:${line.id}`]]);
  assert.equal(hist().length, 0);
  assert.equal(ledger().reduce((a, r) => a + (r.delta as number), 0), 0);            // the ledger nets to zero: what left came back
});

test("a manual adjustment is idempotent by its form key: a retry or double-click moves stock once", async () => {
  const input = { productId: "p-standard", variantId: null, delta: 3, reason: "restock", adminId: "a1", idempotencyKey: "form-1" };
  const a = await adjustStock(input);
  const b = await adjustStock(input);
  assert.deepEqual([a.stockAfter, b.stockAfter, stock("product", "p-standard")], [8, 8, 8]);
  assert.equal(hist().length, 1);
  assert.equal(hist()[0].idempotencyKey, "ADJ:form-1");
  await adjustStock({ ...input, idempotencyKey: "form-2" });
  assert.equal(stock("product", "p-standard"), 11);
});
