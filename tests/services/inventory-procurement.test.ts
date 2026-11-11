import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import { receiveProcurement } from "@/server/services/procurement.service";
import { adjustStock } from "@/server/services/stock-adjustment.service";
import { inventoryState } from "@/lib/inventory-status";
import { backorderRoom, getAvailability, maxOrderableQuantity } from "@/lib/stock";

// Requirement list items 1-15 where they can be exercised against the in-memory DB. Concurrency on REAL PostgreSQL is in
// tests/integration/inventory.postgres.test.ts (the in-memory DB is single-threaded and proves nothing about locking).
let db: FakeDb;
beforeEach(() => { db = freshDb(); seedAdmins(db); seedCatalog(db); });
const P = (id: string) => db.get("product", id);
const add = (user: string, productId: string, quantity: number, variantId: string | null = null) => runAs({ sub: user }, () => addItemToCart({ productId, variantId, quantity }));
const place = (user: string) => runAs({ sub: user }, () => placeOrder(emptyCheckout));
const buy = async (user: string, productId: string, quantity: number, variantId: string | null = null) => { await add(user, productId, quantity, variantId); return place(user); };
const mk = (o: Record<string, unknown>) => db.insert("product", { id: "px", name: "PX", slug: "px", status: "ACTIVE", price: 10, ...o });

test("1-2: tracked stock 1 — quantity 1 accepted, quantity 2 rejected, stock never negative", async () => {
  mk({ stock: 1 });
  await assert.rejects(add("c0", "px", 2));
  await buy("c1", "px", 1);
  assert.equal(P("px").stock, 0);
});

test("4: stock 0 on an ordinary tracked product is rejected", async () => {
  mk({ stock: 0 });
  await assert.rejects(add("c1", "px", 1));
});

test("3 (sequential stand-in): the last unit goes to exactly one of two buyers", async () => {
  mk({ stock: 1 });
  await add("c1", "px", 1);
  await add("c2", "px", 1);
  const results = await Promise.allSettled([place("c1"), place("c2")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(P("px").stock, 0);
});

test("5: stock 0 + procurement enabled is accepted, tracked as pending, stock stays 0", async () => {
  mk({ stock: 0, allowBackorder: true });
  const o = await buy("c1", "px", 2);
  assert.equal(P("px").stock, 0);
  assert.equal(P("px").procurementPending, 2);
  assert.equal(db.rows("orderItem")[0].procurementQty, 2);
  assert.ok(o.id);
});

test("6-7: procurement disabled rejects; a procurement limit is enforced and a rejected order leaves nothing behind", async () => {
  mk({ stock: 0, allowBackorder: false });
  await assert.rejects(add("c1", "px", 1));
  db.patch("product", "px", { allowBackorder: true });
  db.patch("product", "px", { procurementLimit: 3 });
  await buy("c1", "px", 2);                                          // pending 2 of 3
  await assert.rejects(add("c2", "px", 2), /can be ordered|left in stock/); // the cart already refuses more than the room that is left (1)
  // A real race: two shoppers both pass the cart check for the last advance slot; only one can take it at checkout.
  await add("c2", "px", 1);
  await add("c3", "px", 1);
  const results = await Promise.allSettled([place("c2"), place("c3")]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /advance orders/);
  assert.equal(P("px").procurementPending, 3);                       // never above the limit
  assert.equal(db.rows("order").length, 2);                          // the rejected checkout left no order behind
  assert.equal(backorderRoom({ procurementPending: 3, procurementLimit: 3 }), 0);
});

test("8-9: cancelling releases pending exactly once; a duplicate cancel is rejected and changes nothing", async () => {
  mk({ stock: 1, allowBackorder: true });
  const o = await buy("c1", "px", 3);
  assert.deepEqual([P("px").stock, P("px").procurementPending], [0, 2]);
  await adminUpdateOrderStatus(o.id, "CANCELLED", undefined, TEST_ADMIN);
  assert.deepEqual([P("px").stock, P("px").procurementPending], [1, 0]);
  await assert.rejects(adminUpdateOrderStatus(o.id, "CANCELLED", undefined, TEST_ADMIN));
  assert.deepEqual([P("px").stock, P("px").procurementPending], [1, 0]);
});

test("receiving goods: waiting orders are served first (oldest first), only the surplus becomes sellable stock", async () => {
  mk({ stock: 0, allowBackorder: true });
  const a = await buy("c1", "px", 2);
  await buy("c2", "px", 1);
  const r = await receiveProcurement({ productId: "px", quantity: 5, adminId: "a1" });
  assert.deepEqual([r.allocatedToOrders, r.addedToStock], [3, 2]);
  assert.deepEqual([P("px").stock, P("px").procurementPending], [2, 0]);
  assert.deepEqual(db.rows("orderItem").map((i) => i.procurementReceivedQty), [2, 1]);
  assert.equal(db.rows("procurementReceipt").length, 1);
  // Cancelling an order whose goods already arrived returns those units to sellable stock; nothing is released twice.
  await adminUpdateOrderStatus(a.id, "CANCELLED", undefined, TEST_ADMIN);
  assert.deepEqual([P("px").stock, P("px").procurementPending], [4, 0]);
  await assert.rejects(receiveProcurement({ productId: "px", quantity: 0, adminId: "a1" }));
});

test("partial receipt leaves the rest pending; nothing is counted both as stock and incoming", async () => {
  mk({ stock: 0, allowBackorder: true });
  await buy("c1", "px", 4);
  const r = await receiveProcurement({ productId: "px", quantity: 1, adminId: "a1" });
  assert.deepEqual([r.allocatedToOrders, r.addedToStock, P("px").stock, P("px").procurementPending], [1, 0, 0, 3]);
});

test("dispatch is blocked while units are still waiting to be sourced, and allowed once received", async () => {
  mk({ stock: 0, allowBackorder: true });
  const o = await buy("c1", "px", 1);
  await adminUpdateOrderStatus(o.id, "CONFIRMED", undefined, TEST_ADMIN);
  await adminUpdateOrderStatus(o.id, "PROCESSING", undefined, TEST_ADMIN);
  await assert.rejects(adminUpdateOrderStatus(o.id, "SHIPPED", undefined, TEST_ADMIN), /still waiting to be sourced/);
  await receiveProcurement({ productId: "px", quantity: 1, adminId: "a1" });
  await adminUpdateOrderStatus(o.id, "SHIPPED", undefined, TEST_ADMIN);
});

test("11: variant stock and procurement are tracked on the variant, independently of the product", async () => {
  await buy("c1", "p-variant", 2, "v-red"); // v-red has 3
  assert.equal(db.get("productVariant", "v-red").stock, 1);
  await assert.rejects(add("c2", "p-variant", 2, "v-red"));
  assert.equal(db.get("productVariant", "v-blue").stock, 0);
  db.patch("productVariant", "v-blue", { allowBackorder: true });
  await buy("c3", "p-variant", 2, "v-blue");
  assert.deepEqual([db.get("productVariant", "v-blue").stock, db.get("productVariant", "v-blue").procurementPending], [0, 2]);
});

test("13: status uses available stock and the pending counter", () => {
  const base = { trackInventory: true, lowStockThreshold: 5, allowBackorder: false, procurementPending: 0, procurementLimit: null };
  assert.equal(inventoryState({ ...base, stock: 9 }), "in_stock");
  assert.equal(inventoryState({ ...base, stock: 5 }), "low_stock");
  assert.equal(inventoryState({ ...base, stock: 0 }), "out_of_stock");
  assert.equal(inventoryState({ ...base, stock: 0, allowBackorder: true }), "procurement_required");
  assert.equal(inventoryState({ ...base, stock: 0, allowBackorder: true, procurementPending: 2 }), "procurement_pending");
  assert.equal(inventoryState({ ...base, stock: 0, allowBackorder: true, procurementPending: 3, procurementLimit: 3 }), "out_of_stock");
  assert.equal(inventoryState({ ...base, stock: 0, trackInventory: false }), "untracked");
  assert.equal(maxOrderableQuantity({ stock: 2, allowBackorder: true, trackInventory: true, procurementPending: 1, procurementLimit: 4 }), 5);
  assert.equal(getAvailability({ stock: 0, allowBackorder: true, trackInventory: true, procurementPending: 4, procurementLimit: 4 }).inStock, false);
});

test("14: manual adjustments that would make stock negative are rejected", async () => {
  mk({ stock: 2 });
  await assert.rejects(adjustStock({ productId: "px", variantId: null, delta: -3, reason: "recount", adminId: "a1" }));
  assert.equal(P("px").stock, 2);
});

test("15: a failed multi-item checkout leaves no order and no stock/pending change", async () => {
  mk({ stock: 5 });
  db.insert("product", { id: "py", name: "PY", slug: "py", status: "ACTIVE", price: 10, stock: 1 });
  await add("c1", "px", 2);
  await add("c1", "py", 1);
  db.patch("product", "py", { stock: 0 }); // someone else took the last unit before checkout
  await assert.rejects(place("c1"));
  assert.equal(P("px").stock, 5);
  assert.equal(db.rows("order").length, 0);
});
