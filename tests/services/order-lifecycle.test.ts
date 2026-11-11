import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder, requestRefund } from "@/server/services/order.service";
import { restoreOrderStock } from "@/server/services/order-inventory";
import { recordIncident } from "@/server/services/incident.service";
import { dhakaDay } from "../setup/helpers";
import { InvalidOrderTransitionError } from "@/lib/order-transitions";

let db: FakeDb;
beforeEach(() => { db = freshDb(); seedAdmins(db); seedCatalog(db); });
const stock = (table: string, id: string) => db.get(table, id).stock as number;
const status = (id: string) => db.get("order", id).status as string;

async function orderOf(productId: string, quantity: number, variantId: string | null = null, user = "cust") {
  await runAs({ sub: user }, () => addItemToCart({ productId, variantId, quantity }));
  return runAs({ sub: user }, () => placeOrder(emptyCheckout));
}
const move = (id: string, to: string) => adminUpdateOrderStatus(id, to as never, undefined, TEST_ADMIN);
async function advanceTo(id: string, path: string[]) { for (const s of path) await move(id, s); }

test("PENDING → CANCELLED restores stock exactly once; second cancel is rejected", async () => {
  const o = await orderOf("p-standard", 2);
  assert.equal(stock("product", "p-standard"), 3);
  await move(o.id, "CANCELLED");
  assert.equal(stock("product", "p-standard"), 5);
  assert.notEqual(db.rows("orderItem")[0].stockRestoredAt, null);
  await assert.rejects(move(o.id, "CANCELLED"), InvalidOrderTransitionError);
  assert.equal(stock("product", "p-standard"), 5); // not 7
});

test("the invalid transitions from the brief are rejected and change nothing", async () => {
  const o = await orderOf("p-standard", 1);
  await assert.rejects(move(o.id, "REFUNDED"), /can't move/); // PENDING → REFUNDED
  await advanceTo(o.id, ["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"]);
  for (const bad of ["PROCESSING", "CANCELLED", "PENDING", "SHIPPED"]) {
    await assert.rejects(move(o.id, bad), InvalidOrderTransitionError, `DELIVERED → ${bad}`);
  }
  assert.equal(status(o.id), "DELIVERED");
  assert.equal(stock("product", "p-standard"), 4); // delivered stock stays consumed
  await assert.rejects(adminUpdateOrderStatus(o.id, "NOT_A_STATUS" as never, undefined, TEST_ADMIN), /Invalid order status/);
});

const restockIncident = (orderItemId: string, quantity: number, over: Record<string, unknown> = {}) =>
  recordIncident({ kind: "CUSTOMER_RETURN", occurredOn: dhakaDay(), orderItemId, quantity, stockEffect: "RESTOCK", lossAmount: 0, refundAmount: 0, courierFee: 0, ...over } as never, "a1");

test("REFUND flow: refunding a DELIVERED order does NOT assume the goods came back; only a sellable-restock incident puts units back, once", async () => {
  const o = await orderOf("p-standard", 2);
  await advanceTo(o.id, ["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]);
  assert.equal(stock("product", "p-standard"), 3);
  await runAs({ sub: "cust" }, () => requestRefund(o.orderNumber, "damaged"));
  assert.equal(status(o.id), "REFUND_REQUESTED");
  assert.equal(stock("product", "p-standard"), 3); // requesting does not restore
  await move(o.id, "REFUNDED");
  assert.equal(stock("product", "p-standard"), 3); // refunded ≠ returned: the units are still out until someone records what came back
  for (const bad of ["DELIVERED", "PROCESSING", "CANCELLED", "REFUNDED"]) {
    await assert.rejects(move(o.id, bad), InvalidOrderTransitionError, `REFUNDED → ${bad}`);
  }
  const line = db.rows("orderItem")[0];
  await restockIncident(line.id as string, 1);                    // one unit came back sellable
  assert.equal(stock("product", "p-standard"), 4);
  await restockIncident(line.id as string, 1, { stockEffect: "DISCARD" }); // the other came back broken: stays out
  assert.equal(stock("product", "p-standard"), 4);
  await assert.rejects(restockIncident(line.id as string, 1), /already back in stock or marked unsellable/);
  assert.equal(stock("product", "p-standard"), 4);
});

test("refund request only from DELIVERED, only for your own order, only once", async () => {
  const o = await orderOf("p-standard", 1);
  await assert.rejects(runAs({ sub: "cust" }, () => requestRefund(o.orderNumber, "x")), /delivered/i);
  await advanceTo(o.id, ["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"]);
  await assert.rejects(runAs({ sub: "someone-else" }, () => requestRefund(o.orderNumber, "x")), /not found/i);
  await runAs({ sub: "cust" }, () => requestRefund(o.orderNumber, "x"));
  await assert.rejects(runAs({ sub: "cust" }, () => requestRefund(o.orderNumber, "x")), /delivered/i);
});

test("rejecting a refund returns to DELIVERED without touching stock", async () => {
  const o = await orderOf("p-standard", 1);
  await advanceTo(o.id, ["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "REFUND_REQUESTED", "DELIVERED"]);
  assert.equal(stock("product", "p-standard"), 4);
});

test("failed delivery keeps stock held; CANCELLED afterwards does not guess; the returned parcel is restocked by an incident exactly once", async () => {
  const o = await orderOf("p-standard", 2);
  await advanceTo(o.id, ["CONFIRMED", "PROCESSING", "SHIPPED", "FAILED_DELIVERY"]);
  assert.equal(stock("product", "p-standard"), 3);
  await move(o.id, "OUT_FOR_DELIVERY"); // retry
  assert.equal(stock("product", "p-standard"), 3); // no second decrement
  await move(o.id, "FAILED_DELIVERY");
  await move(o.id, "CANCELLED");
  assert.equal(stock("product", "p-standard"), 3); // the parcel is with the courier: not assumed back, not assumed sellable
  const line = db.rows("orderItem")[0];
  await restockIncident(line.id as string, 2, { kind: "FAILED_DELIVERY" });
  assert.equal(stock("product", "p-standard"), 5);
  await assert.rejects(restockIncident(line.id as string, 1, { kind: "FAILED_DELIVERY" }), /already back/);
  assert.equal(stock("product", "p-standard"), 5);
});

test("a restock incident BEFORE the order is cancelled can never be restored a second time by the cancel", async () => {
  const o = await orderOf("p-standard", 3);
  await advanceTo(o.id, ["CONFIRMED", "PROCESSING", "SHIPPED", "FAILED_DELIVERY"]);
  const line = db.rows("orderItem")[0];
  await restockIncident(line.id as string, 2, { kind: "FAILED_DELIVERY" }); // 2 of 3 came back sellable
  assert.equal(stock("product", "p-standard"), 4);
  await move(o.id, "CANCELLED");                                             // old code restored all 3 again here (stock 7)
  assert.equal(stock("product", "p-standard"), 4);
  await restockIncident(line.id as string, 1, { kind: "FAILED_DELIVERY" }); // the last unit
  assert.equal(stock("product", "p-standard"), 5);
  assert.equal(db.rows("orderItem")[0].stockReturnedQty, 3);
});

test("variant orders restore the VARIANT stock, never the product stock", async () => {
  const o = await orderOf("p-variant", 2, "v-red");
  assert.equal(stock("productVariant", "v-red"), 1);
  await move(o.id, "CANCELLED");
  assert.equal(stock("productVariant", "v-red"), 3);
  assert.equal(stock("product", "p-variant"), 999);
});

test("stock that was never decremented is never restored (untracked / legacy lines)", async () => {
  db.insert("product", { id: "p-mto", name: "MTO", slug: "mto", status: "ACTIVE", price: 50, stock: 7, trackInventory: false });
  const o = await orderOf("p-mto", 3);
  assert.equal(stock("product", "p-mto"), 7);
  // admin later turns inventory tracking ON before the order is cancelled
  await db.product.update({ where: { id: "p-mto" }, data: { trackInventory: true } });
  await move(o.id, "CANCELLED");
  assert.equal(stock("product", "p-mto"), 7); // would have been 10 with the old logic
  // legacy order rows (pre-migration default stockDeducted = 0)
  db.insert("order", { id: "legacy", orderNumber: "AP-LEGACY", status: "PENDING" });
  db.insert("orderItem", { id: "li", orderId: "legacy", productId: "p-standard", quantity: 4 });
  await move("legacy", "CANCELLED");
  assert.equal(stock("product", "p-standard"), 5);
});

test("restore is idempotent: calling the restore routine repeatedly never double-restores", async () => {
  const o = await orderOf("p-standard", 2);
  await db.order.update({ where: { id: o.id }, data: { status: "CANCELLED" } }); // simulate status already applied
  await restoreOrderStock(db as never, o.id);
  await restoreOrderStock(db as never, o.id);
  await Promise.all([restoreOrderStock(db as never, o.id), restoreOrderStock(db as never, o.id)]);
  assert.equal(stock("product", "p-standard"), 5);
});

test("two admins cancelling at the same moment: one succeeds, stock restored once", async () => {
  const o = await orderOf("p-standard", 2);
  const results = await Promise.allSettled([move(o.id, "CANCELLED"), move(o.id, "CANCELLED")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(stock("product", "p-standard"), 5);
});

test("a cancelled order can never be re-opened to consume stock again", async () => {
  const o = await orderOf("p-standard", 1);
  await move(o.id, "CANCELLED");
  for (const s of ["PENDING", "CONFIRMED", "PROCESSING", "DELIVERED", "REFUNDED"]) {
    await assert.rejects(move(o.id, s), InvalidOrderTransitionError);
  }
  assert.equal(stock("product", "p-standard"), 5);
});

test("backorder/procurement: stock NEVER goes negative; the excess is tracked as pending and released symmetrically", async () => {
  db.insert("product", { id: "p-bo", name: "BO", slug: "bo", status: "ACTIVE", price: 10, stock: 1, allowBackorder: true });
  const o = await orderOf("p-bo", 3);
  assert.equal(stock("product", "p-bo"), 0);
  assert.equal(db.get("product", "p-bo").procurementPending, 2);
  assert.deepEqual([db.rows("orderItem")[0].stockDeducted, db.rows("orderItem")[0].procurementQty], [1, 2]);
  await move(o.id, "CANCELLED");
  assert.equal(stock("product", "p-bo"), 1);
  assert.equal(db.get("product", "p-bo").procurementPending, 0);
});

test("a variant deleted after ordering: restore skips it instead of crediting the product stock", async () => {
  const o = await orderOf("p-variant", 1, "v-red");
  await db.productVariant.deleteMany({ where: { id: "v-red" } });
  await db.orderItem.updateMany({ where: { orderId: o.id }, data: { variantId: null } }); // FK SET NULL
  await move(o.id, "CANCELLED");
  assert.equal(stock("product", "p-variant"), 999);
});

test("a transition's failure rolls back (no status change, no tracking event)", async () => {
  const o = await orderOf("p-standard", 1);
  const events = db.rows("orderTrackingEvent").length;
  await assert.rejects(move(o.id, "DELIVERED"));
  assert.equal(status(o.id), "PENDING");
  assert.equal(db.rows("orderTrackingEvent").length, events);
});
