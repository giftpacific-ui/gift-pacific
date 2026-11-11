import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dhakaDay, emptyCheckout, freshDb, runAs, seedCatalog, TEST_ADMIN, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { prisma } from "@/lib/db/prisma";
import { addItemToCart } from "@/server/services/cart.service";
import { adminUpdateOrderStatus, placeOrder } from "@/server/services/order.service";
import { restoreOrderStock } from "@/server/services/order-inventory";
import { listGoodsStillOut, recordIncident } from "@/server/services/incident.service";
import { receiveProcurement } from "@/server/services/procurement.service";
import { createExternalOrder } from "@/server/services/external-order.service";
import { applyLegacyBackorderLinks, previewInventoryReconciliation } from "@/server/services/inventory-reconcile.service";

let db: FakeDb;
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
const P = (id: string) => db.get("product", id);
const stock = (id: string) => P(id).stock as number;
const pending = (id: string) => P(id).procurementPending as number;
const ledger = () => db.rows("stockAdjustment");
const sel = (slotId: string, optionId: string, quantity = 1) => ({ slotId, optionId, quantity });
const move = (id: string, to: string) => adminUpdateOrderStatus(id, to as never, undefined, TEST_ADMIN);
const path = async (id: string, steps: string[]) => { for (const s of steps) await move(id, s); };
const SHIP = ["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];
const buy = async (user: string, productId: string, quantity: number, variantId: string | null = null) => {
  await runAs({ sub: user }, () => addItemToCart({ productId, variantId, quantity }));
  return runAs({ sub: user }, () => placeOrder(emptyCheckout));
};
const incident = (o: Record<string, unknown>) => recordIncident({ kind: "CUSTOMER_RETURN", occurredOn: dhakaDay(), quantity: 1, stockEffect: "NONE", lossAmount: 0, refundAmount: 0, courierFee: 0, ...o } as never, "a1");
const lineOf = (orderId: string) => db.rows("orderItem").find((i) => i.orderId === orderId)!;
const noNegative = () => { for (const t of ["product", "productVariant"]) for (const r of db.rows(t)) assert.ok((r.stock as number) >= 0 && ((r.procurementPending as number) ?? 0) >= 0, `${t}/${r.id} went negative`); };

beforeEach(() => {
  db = freshDb(); seedAdmins(db);
  seedCatalog(db); // p-standard stock 5; p-variant v-red 3 / v-blue 0; p-bundle = OWN_STOCK combo (stock 2, components: 2 vases)
  db.insert("salesChannel", { id: "channel_website", key: "website", name: "Website", kind: "WEBSITE" });
  db.insert("salesChannel", { id: "channel_fb", key: "facebook", name: "Facebook Shop", kind: "OTHER" });
  db.insert("product", { id: "px", name: "PX", slug: "px", status: "ACTIVE", price: 10, costPrice: 4, stock: 0 });
  db.insert("product", { id: "p-box", name: "Heart Box", slug: "heart-box", type: "STANDARD", status: "ACTIVE", price: 200, costPrice: 80, stock: 1, allowBackorder: true, description: "x" });
  db.insert("product", { id: "p-custom", name: "Build Your Box", slug: "build-your-box", type: "BUNDLE", status: "ACTIVE", price: 1000, stock: 0, description: "x", kind: "COMBO", comboMode: "CUSTOMIZABLE", comboPricing: "FIXED_PRICE", comboStockPolicy: "COMPONENTS" });
  db.insert("comboSlot", { id: "s-box", comboId: "p-custom", label: "Box", minSelect: 1, maxSelect: 1, maxPerOption: 1, sortOrder: 0 });
  db.insert("comboSlot", { id: "s-items", comboId: "p-custom", label: "Items", minSelect: 1, maxSelect: 3, maxPerOption: 2, sortOrder: 1 });
  db.insert("comboSlotOption", { id: "o-box", slotId: "s-box", productId: "p-box", priceDelta: 0, sortOrder: 0 });
  db.insert("comboSlotOption", { id: "o-vase", slotId: "s-items", productId: "p-standard", priceDelta: 0, sortOrder: 0 });
});

// ---- concurrent purchases ------------------------------------------------------------------------------------------------------------
test("concurrent purchases for the last units: never oversold, never negative, one ledger row per sale", async () => {
  db.patch("product", "p-standard", { stock: 2 });
  for (const u of ["c1", "c2", "c3", "c4", "c5"]) await runAs({ sub: u }, () => addItemToCart({ productId: "p-standard", quantity: 1 }));
  const results = await Promise.allSettled(["c1", "c2", "c3", "c4", "c5"].map((u) => runAs({ sub: u }, () => placeOrder(emptyCheckout))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(results.filter((r) => r.status === "rejected").length, 3);
  assert.equal(stock("p-standard"), 0);
  assert.equal(db.rows("order").length, 2);                                   // a rejected checkout leaves no order
  assert.equal(ledger().filter((r) => r.kind === "ORDER_PLACED").length, 2);
  noNegative();
});

test("backorder DISABLED: the units beyond stock are refused. ENABLED: they are tracked explicitly as pending, never as negative stock", async () => {
  db.patch("product", "px", { stock: 1 });
  const off = await Promise.allSettled([buy("a", "px", 1), buy("b", "px", 1)]);
  assert.equal(off.filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual([stock("px"), pending("px")], [0, 0]);

  db.patch("product", "px", { allowBackorder: true });
  const o = await buy("c", "px", 3);
  assert.deepEqual([stock("px"), pending("px")], [0, 3]);                     // 3 awaited, stock stays 0
  const l = lineOf(o.id);
  assert.deepEqual([l.stockDeducted, l.procurementQty, l.procurementReceivedQty], [0, 3, 0]);
  noNegative();
});

// ---- duplicate deduction / restoration -----------------------------------------------------------------------------------------------
test("duplicate restoration: the release routine, a repeated cancel and a retried ledger write move stock once", async () => {
  const o = await buy("c", "p-standard", 2);
  assert.equal(stock("p-standard"), 3);
  await move(o.id, "CANCELLED");
  assert.equal(stock("p-standard"), 5);
  for (let i = 0; i < 3; i++) assert.equal(await prisma.$transaction((tx) => restoreOrderStock(tx, o.id, "FULL")), 0);
  await assert.rejects(move(o.id, "CANCELLED"));
  assert.equal(stock("p-standard"), 5);
  assert.deepEqual(ledger().map((r) => [r.kind, r.delta]), [["ORDER_PLACED", -2], ["ORDER_RELEASED", 2]]);
  assert.equal(lineOf(o.id).stockReturnedQty, 2);
});

test("a release after units were already accounted for (e.g. migrated history) gives back only the remainder, never the whole line again", async () => {
  const o = await buy("c", "p-standard", 3);                                  // stock 2
  await path(o.id, ["CONFIRMED", "PROCESSING"]);
  db.patch("orderItem", lineOf(o.id).id as string, { stockReturnedQty: 1, stockDiscardedQty: 1 }); // 2 of the 3 units already settled by earlier history
  await move(o.id, "CANCELLED");
  assert.equal(stock("p-standard"), 3);                                       // 2 + the single unit still out; not 2 + 3
  assert.equal(lineOf(o.id).stockReturnedQty, 2);
});

test("duplicate deduction: an order is deducted once; a status retry never deducts again", async () => {
  const o = await buy("c", "p-standard", 2);
  await path(o.id, ["CONFIRMED", "PROCESSING", "SHIPPED", "FAILED_DELIVERY", "OUT_FOR_DELIVERY", "FAILED_DELIVERY", "OUT_FOR_DELIVERY"]);
  assert.equal(stock("p-standard"), 3);
  assert.equal(ledger().filter((r) => r.kind === "ORDER_PLACED").length, 1);
});

test("an incident submitted twice (same key) restocks once; a different event with its own key is a separate record", async () => {
  const o = await buy("c", "p-standard", 3);
  await path(o.id, SHIP);
  const first = await incident({ orderItemId: lineOf(o.id).id, stockEffect: "RESTOCK", quantity: 1, idempotencyKey: "k1" });
  const retry = await incident({ orderItemId: lineOf(o.id).id, stockEffect: "RESTOCK", quantity: 1, idempotencyKey: "k1" });
  assert.deepEqual([first.duplicate, retry.duplicate, retry.id], [false, true, first.id]);
  assert.equal(stock("p-standard"), 3);                                       // 5 − 3 + 1
  assert.equal(db.rows("financialIncident").length, 1);
  await incident({ orderItemId: lineOf(o.id).id, stockEffect: "RESTOCK", quantity: 1, idempotencyKey: "k2" });
  assert.equal(stock("p-standard"), 4);
});

// ---- cancellation, failed delivery ---------------------------------------------------------------------------------------------------
test("cancellation before dispatch returns the units automatically (PENDING, CONFIRMED and PROCESSING alike)", async () => {
  for (const upTo of [[], ["CONFIRMED"], ["CONFIRMED", "PROCESSING"]]) {
    db = freshDb(); seedAdmins(db); seedCatalog(db);
    db.insert("salesChannel", { id: "channel_website", key: "website", name: "Website", kind: "WEBSITE" });
    const o = await buy("c", "p-standard", 2);
    await path(o.id, upTo);
    await move(o.id, "CANCELLED");
    assert.equal(stock("p-standard"), 5, upTo.join(">"));
  }
});

test("failed delivery then cancel: nothing is guessed; sellable and unsellable units are accounted separately, each exactly once", async () => {
  const o = await buy("c", "p-standard", 3);
  await path(o.id, ["CONFIRMED", "PROCESSING", "SHIPPED", "FAILED_DELIVERY", "CANCELLED"]);
  assert.equal(stock("p-standard"), 2);                                       // still out
  const id = lineOf(o.id).id;
  await incident({ kind: "FAILED_DELIVERY", orderItemId: id, stockEffect: "RESTOCK", quantity: 2 });
  await incident({ kind: "FAILED_DELIVERY", orderItemId: id, stockEffect: "DISCARD", quantity: 1, lossAmount: 700 });
  assert.equal(stock("p-standard"), 4);                                       // 2 sellable came back, 1 damaged stayed out
  await assert.rejects(incident({ kind: "FAILED_DELIVERY", orderItemId: id, stockEffect: "RESTOCK", quantity: 1 }), /already back in stock or marked unsellable/);
  const l = lineOf(o.id);
  assert.deepEqual([l.stockReturnedQty, l.stockDiscardedQty], [2, 1]);
  noNegative();
});

// ---- partial / full return, sellable vs damaged --------------------------------------------------------------------------------------
test("partial and full return of a delivered order; sellable returns restock, damaged returns never do", async () => {
  const o = await buy("c", "p-standard", 4);
  await path(o.id, SHIP);
  const id = lineOf(o.id).id;
  assert.equal(stock("p-standard"), 1);
  await incident({ orderItemId: id, stockEffect: "RESTOCK", quantity: 1 });                        // partial: 1 sellable
  assert.equal(stock("p-standard"), 2);
  await incident({ orderItemId: id, stockEffect: "DISCARD", quantity: 1, lossAmount: 700 });       // 1 damaged: stays out
  assert.equal(stock("p-standard"), 2);
  await assert.rejects(incident({ orderItemId: id, stockEffect: "RESTOCK", quantity: 3 }), /Only 2 units/);   // cannot restock what is already accounted for
  await incident({ orderItemId: id, stockEffect: "RESTOCK", quantity: 2 });                        // the rest: full return
  assert.equal(stock("p-standard"), 4);
  assert.equal(remaining(id), 0);
  await assert.rejects(incident({ orderItemId: id, stockEffect: "DISCARD", quantity: 1 }), /already back/);
  // a refund + REFUNDED afterwards changes nothing about stock
  await path(o.id, ["REFUND_REQUESTED", "REFUNDED"]);
  assert.equal(stock("p-standard"), 4);
  noNegative();
});
const remaining = (lineId: string) => { const l = db.get("orderItem", lineId); return (l.stockDeducted as number) + (l.procurementReceivedQty as number) - (l.stockReturnedQty as number) - (l.stockDiscardedQty as number); };

test("returns are refused when they cannot be true: goods not shipped yet, units never taken from stock, and a write-off on an order line", async () => {
  const o = await buy("c", "p-standard", 2);
  await assert.rejects(incident({ orderItemId: lineOf(o.id).id, stockEffect: "RESTOCK", quantity: 1 }), /have not left/);
  await assert.rejects(incident({ kind: "UNSELLABLE_WRITE_OFF", orderItemId: lineOf(o.id).id, stockEffect: "WRITE_OFF", quantity: 1, lossAmount: 5 }), /already left stock/);
  db.insert("product", { id: "p-mto", name: "MTO", slug: "mto", status: "ACTIVE", price: 5, stock: 7, trackInventory: false });
  const m = await buy("c2", "p-mto", 2);
  await path(m.id, SHIP);
  await assert.rejects(incident({ orderItemId: lineOf(m.id).id, stockEffect: "RESTOCK", quantity: 1 }), /never took units/);
  assert.equal(stock("p-standard"), 3);
  assert.equal(stock("p-mto"), 7);
});

test("two returns recorded at the same moment cannot restock the same unit twice", async () => {
  const o = await buy("c", "p-standard", 3);
  await path(o.id, SHIP);
  const id = lineOf(o.id).id;
  const r = await Promise.allSettled([incident({ orderItemId: id, stockEffect: "RESTOCK", quantity: 2 }), incident({ orderItemId: id, stockEffect: "RESTOCK", quantity: 2 })]);
  assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(stock("p-standard"), 4);                                       // 5 − 3 + 2, not +4
});

test("WRITE_OFF removes units that are on the shelf, never below zero, and stays out of sellable stock", async () => {
  await incident({ kind: "UNSELLABLE_WRITE_OFF", productId: "p-standard", stockEffect: "WRITE_OFF", quantity: 2, lossAmount: 100 });
  assert.equal(stock("p-standard"), 3);
  await assert.rejects(incident({ kind: "UNSELLABLE_WRITE_OFF", productId: "p-standard", stockEffect: "WRITE_OFF", quantity: 9, lossAmount: 1 }), /Not enough stock/);
  assert.equal(stock("p-standard"), 3);
  assert.equal(ledger().at(-1)!.kind, "INCIDENT_WRITE_OFF");
});

test("the admin is told which units are still out after a failed delivery / refund — and nothing for goods that never left", async () => {
  const o = await buy("c", "p-standard", 3);
  assert.deepEqual(await listGoodsStillOut(o.id), []);                          // not shipped: returns automatically on cancel
  await path(o.id, ["CONFIRMED", "PROCESSING", "SHIPPED", "FAILED_DELIVERY", "CANCELLED"]);
  assert.deepEqual((await listGoodsStillOut(o.id)).map((x) => [x.productName, x.remaining]), [["Clay Vase", 3]]);
  await incident({ kind: "FAILED_DELIVERY", orderItemId: lineOf(o.id).id, stockEffect: "RESTOCK", quantity: 3 });
  assert.deepEqual(await listGoodsStillOut(o.id), []);
});

// ---- procurement: ordered vs received ------------------------------------------------------------------------------------------------
test("procurement: ordered 5, stock 2 → 2 taken + 3 awaited; partial receipts are counted exactly; dispatch waits for the last unit; surplus becomes stock", async () => {
  db.patch("product", "px", { stock: 2, allowBackorder: true });
  const o = await buy("c", "px", 5);
  let l = lineOf(o.id);
  assert.deepEqual([stock("px"), pending("px"), l.stockDeducted, l.procurementQty, l.procurementReceivedQty], [0, 3, 2, 3, 0]);
  await path(o.id, ["CONFIRMED", "PROCESSING"]);
  const r1 = await receiveProcurement({ productId: "px", quantity: 1, adminId: "a1", idempotencyKey: "r1" });
  assert.deepEqual([r1.allocatedToOrders, r1.addedToStock, stock("px"), pending("px")], [1, 0, 0, 2]);
  await assert.rejects(move(o.id, "SHIPPED"), /2 units are still waiting/);
  const retry = await receiveProcurement({ productId: "px", quantity: 1, adminId: "a1", idempotencyKey: "r1" });
  assert.equal(retry.duplicate, true);
  assert.deepEqual([pending("px"), lineOf(o.id).procurementReceivedQty], [2, 1]);              // the retry changed nothing
  const r2 = await receiveProcurement({ productId: "px", quantity: 6, adminId: "a1" });
  assert.deepEqual([r2.allocatedToOrders, r2.addedToStock, stock("px"), pending("px")], [2, 4, 4, 0]);
  l = lineOf(o.id);
  assert.deepEqual([l.procurementQty, l.procurementReceivedQty], [3, 3]);
  await move(o.id, "SHIPPED");
  const goods = db.rows("procurementReceipt");
  assert.deepEqual([goods.reduce((a, g) => a + (g.quantity as number), 0), goods.reduce((a, g) => a + (g.allocatedToOrders as number) + (g.addedToStock as number), 0)], [7, 7]); // received = allocated + stock, always
  noNegative();
});

test("cancelling a partly received backorder gives back exactly the units that physically exist and releases the rest of the pending count", async () => {
  db.patch("product", "px", { stock: 2, allowBackorder: true });
  const o = await buy("c", "px", 5);                                           // 2 taken, 3 awaited
  await receiveProcurement({ productId: "px", quantity: 1, adminId: "a1" });   // 1 arrives and is reserved for this order
  await move(o.id, "CANCELLED");
  assert.deepEqual([stock("px"), pending("px")], [3, 0]);                      // 2 + 1 physical units, nothing phantom
  assert.equal(await prisma.$transaction((tx) => restoreOrderStock(tx, o.id, "FULL")), 0);
  assert.deepEqual([stock("px"), pending("px")], [3, 0]);
});

// ---- combos / components --------------------------------------------------------------------------------------------------------------
const combo = (qty: number, vases = 2) => addItemToCart({ productId: "p-custom", quantity: qty, selections: [sel("s-box", "o-box"), sel("s-items", "o-vase", vases)] });
const comboOrder = async (user: string, qty: number, vases = 2) => { await runAs({ sub: user }, () => combo(qty, vases)); return runAs({ sub: user }, () => placeOrder(emptyCheckout)); };

test("COMPONENTS combo: only the components' stock moves, once; cancelling before dispatch restores each component once", async () => {
  db.patch("product", "p-box", { stock: 4, allowBackorder: false });
  const o = await comboOrder("c", 2);
  assert.deepEqual([stock("p-box"), stock("p-standard"), stock("p-custom")], [2, 1, 0]);      // 2 boxes + 4 vases; the combo's own stock untouched
  assert.equal(lineOf(o.id).stockDeducted, 0);
  await path(o.id, ["CONFIRMED", "CANCELLED"]);
  assert.deepEqual([stock("p-box"), stock("p-standard"), stock("p-custom")], [4, 5, 0]);
  await assert.rejects(move(o.id, "CANCELLED"));
  assert.equal(await prisma.$transaction((tx) => restoreOrderStock(tx, o.id, "FULL")), 0);
  assert.deepEqual([stock("p-box"), stock("p-standard")], [4, 5]);
  assert.equal(lineOf(o.id).stockReturnedQty, 2);                                              // both combos count as back: a later restock incident is refused
});

test("OWN_STOCK combo: only the combo's own stock moves; components are never deducted a second time", async () => {
  const o = await buy("c", "p-bundle", 1);
  assert.deepEqual([stock("p-bundle"), stock("p-standard")], [1, 5]);
  assert.equal(db.rows("orderItemComponent").filter((c) => c.orderItemId === lineOf(o.id).id && (c.stockDeducted as number) > 0).length, 0);
  await move(o.id, "CANCELLED");
  assert.deepEqual([stock("p-bundle"), stock("p-standard")], [2, 5]);
});

test("combo components are never sold beyond physical stock: the cart and checkout refuse it, so no component can ever be left 'awaited'", async () => {
  db.patch("product", "p-box", { stock: 1, allowBackorder: true });                            // even a backorder-enabled component product...
  await assert.rejects(runAs({ sub: "c" }, () => combo(3, 1)), /left in stock/);               // ...limits the combo (resolveComponent hard-codes allowBackorder: false)
  assert.equal(db.rows("orderItemComponent").length, 0);
  assert.deepEqual([stock("p-box"), pending("p-box")], [1, 0]);
});

test("defensive: IF a component row ever awaits goods, receipts reach it, dispatch waits for it, and a cancel releases only what physically exists", async () => {
  // Not reachable through the current checkout (see the test above); built directly so the guard is proven rather than assumed.
  db.patch("product", "p-box", { stock: 0, procurementPending: 2 });
  const mk = (id: string, status: string, hoursAgo: number) => {
    db.insert("order", { id, orderNumber: `AP-${id}`, status, channelId: "channel_website", total: 10, subtotal: 10, phone: "0", createdAt: new Date(Date.now() - hoursAgo * 3600 * 1000) });
    db.insert("orderItem", { id: `li-${id}`, orderId: id, productId: "p-custom", productName: "Combo", quantity: 2, unitPrice: 5, lineTotal: 10, stockDeducted: 0 });
    db.insert("orderItemComponent", { id: `ci-${id}`, orderItemId: `li-${id}`, productId: "p-box", productName: "Heart Box", quantity: 1, stockDeducted: 1, procurementQty: 1 });
  };
  mk("W1", "PROCESSING", 5);                                                                    // owns 1 awaited box
  db.patch("product", "p-box", { procurementPending: 2 });
  mk("W2", "PROCESSING", 1);                                                                    // owns 1 awaited box
  await assert.rejects(move("W1", "SHIPPED"), /1 unit is still waiting/);
  const r = await receiveProcurement({ productId: "p-box", quantity: 3, adminId: "a1" });
  assert.deepEqual([r.allocatedToOrders, r.addedToStock, pending("p-box"), stock("p-box")], [2, 1, 0, 1]);
  assert.deepEqual(db.rows("orderItemComponent").map((c) => c.procurementReceivedQty), [1, 1]);
  await move("W1", "SHIPPED");
  // a third, still-waiting row that is cancelled releases its pending unit and returns only the box it really took
  db.patch("product", "p-box", { stock: 0, procurementPending: 1 });
  mk("W3", "PROCESSING", 0);
  await move("W3", "CANCELLED");
  assert.deepEqual([stock("p-box"), pending("p-box")], [1, 0]);
  noNegative();
});

test("returning shipped combos restocks every component in proportion, once; a damaged combo stays out; nothing is restored twice by a refund", async () => {
  db.patch("product", "p-box", { stock: 5, allowBackorder: false });
  const o = await comboOrder("c", 2);                                                          // 2 boxes + 4 vases out → box 3, vase 1
  await path(o.id, SHIP);
  const id = lineOf(o.id).id;
  await incident({ orderItemId: id, stockEffect: "RESTOCK", quantity: 1 });                    // 1 combo back, sellable
  assert.deepEqual([stock("p-box"), stock("p-standard"), stock("p-custom")], [4, 3, 0]);       // the combo product itself never receives phantom stock
  await incident({ orderItemId: id, stockEffect: "DISCARD", quantity: 1, lossAmount: 360 });   // the other one came back broken
  await assert.rejects(incident({ orderItemId: id, stockEffect: "RESTOCK", quantity: 1 }), /already back/);
  await path(o.id, ["REFUND_REQUESTED", "REFUNDED"]);
  assert.deepEqual([stock("p-box"), stock("p-standard")], [4, 3]);
  const comps = db.rows("orderItemComponent").filter((c) => c.orderItemId === id);
  assert.deepEqual(comps.map((c) => [c.productId, c.stockReturnedQty, c.stockDiscardedQty]).sort(), [["p-box", 1, 1], ["p-standard", 2, 2]]);
});

// ---- external orders ------------------------------------------------------------------------------------------------------------------
const ext = (o: Record<string, unknown> = {}) => ({
  channelId: "channel_fb", externalOrderRef: `f-${Math.random().toString(36).slice(2, 8)}`,
  customer: { fullName: "Jo Doe", phone: "01711000000", line1: "House 1, Road 2" },
  items: [{ productId: "p-standard", quantity: 2, unitPrice: 1500 }], shippingTotal: 60, costLines: [], ...o,
});

test("external orders follow the ordinary stock rules: deduct once with a ledger row, restore once before dispatch, never guess after dispatch", async () => {
  const a = await admin(() => createExternalOrder(ext({ status: "CONFIRMED" }), null));
  assert.equal(stock("p-standard"), 3);
  assert.deepEqual(ledger().map((r) => [r.kind, r.delta]), [["ORDER_PLACED", -2]]);
  await move(a.id, "CANCELLED");
  assert.equal(stock("p-standard"), 5);
  assert.deepEqual(ledger().map((r) => r.kind), ["ORDER_PLACED", "ORDER_RELEASED"]);

  const b = await admin(() => createExternalOrder(ext({ status: "SHIPPED" }), null));
  await path(b.id, ["FAILED_DELIVERY", "CANCELLED"]);
  assert.equal(stock("p-standard"), 3);                                                         // parcel not assumed back
  await incident({ kind: "FAILED_DELIVERY", orderItemId: lineOf(b.id).id, stockEffect: "RESTOCK", quantity: 2 });
  assert.equal(stock("p-standard"), 5);
  await assert.rejects(incident({ kind: "FAILED_DELIVERY", orderItemId: lineOf(b.id).id, stockEffect: "RESTOCK", quantity: 1 }), /already back/);
});

test("external order entered with stock policy NONE never touches stock — and cannot later invent units", async () => {
  const o = await admin(() => createExternalOrder(ext({ stockPolicy: "NONE", status: "SHIPPED" }), null));
  assert.equal(stock("p-standard"), 5);
  assert.equal(ledger().length, 0);
  await path(o.id, ["FAILED_DELIVERY", "CANCELLED"]);
  assert.equal(stock("p-standard"), 5);
  await assert.rejects(incident({ kind: "FAILED_DELIVERY", orderItemId: lineOf(o.id).id, stockEffect: "RESTOCK", quantity: 1 }), /never took units/);
});

test("external order cannot oversell or create negative stock, for plain lines and for combo components alike", async () => {
  await assert.rejects(admin(() => createExternalOrder(ext({ items: [{ productId: "p-standard", quantity: 6, unitPrice: 1 }] }), null)), /stock|available|sold out/i);
  db.patch("product", "p-bundle", { comboStockPolicy: "COMPONENTS" });
  db.patch("product", "p-standard", { stock: 1, allowBackorder: true });                       // needs 2 vases per bundle; components never backorder
  await assert.rejects(admin(() => createExternalOrder(ext({ items: [{ productId: "p-bundle", quantity: 1, unitPrice: 4000 }] }), null)), /sold out|stock/i);
  assert.equal(stock("p-standard"), 1);
  assert.equal(db.rows("order").length, 0);                                                    // nothing left behind
  assert.equal(ledger().length, 0);
  noNegative();
});

// ---- reconciliation of legacy data ------------------------------------------------------------------------------------------------------
function legacyFixture() {
  // The state migration 20261105000000 leaves behind: stock floored at 0, the debt in procurementPending, lines still saying "all deducted".
  db.patch("product", "px", { stock: 0, allowBackorder: true, procurementPending: 3 });
  const mk = (id: string, status: string, qty: number, hoursAgo: number) => {
    db.insert("order", { id, orderNumber: `AP-${id}`, status, channelId: "channel_website", total: 10, subtotal: 10, phone: "0", createdAt: new Date(Date.now() - hoursAgo * 3600 * 1000) });
    db.insert("orderItem", { id: `li-${id}`, orderId: id, productId: "px", variantId: null, productName: "PX", quantity: qty, unitPrice: 10, lineTotal: 10 * qty, stockDeducted: qty });
  };
  mk("A", "PROCESSING", 2, 40); mk("B", "CONFIRMED", 2, 30); mk("C", "SHIPPED", 1, 20); mk("D", "PENDING", 1, 10);
}

test("legacy backorders: preview is read-only; apply links the debt to the NEWEST open unshipped lines only, changes no stock/pending, is audited and re-runnable", async () => {
  legacyFixture();
  const before = JSON.stringify([db.rows("product"), db.rows("orderItem")]);
  const report = await admin(() => previewInventoryReconciliation());
  assert.equal(JSON.stringify([db.rows("product"), db.rows("orderItem")]), before);            // preview changed nothing
  assert.deepEqual([report.totals.unlinkedUnits, report.totals.plannedUnits, report.totals.residualUnits], [3, 3, 0]);
  assert.deepEqual(report.skus[0].links.map((l) => [l.orderNumber, l.moveUnits]), [["AP-D", 1], ["AP-B", 2]]);

  await assert.rejects(admin(() => applyLegacyBackorderLinks("a1", 99)), /data changed since the preview/);
  assert.equal(JSON.stringify([db.rows("product"), db.rows("orderItem")]), before);
  const done = await admin(() => applyLegacyBackorderLinks("a1", 3));
  assert.deepEqual(done, { linkedLines: 2, units: 3 });
  const l = (id: string) => db.get("orderItem", `li-${id}`);
  assert.deepEqual(["A", "B", "C", "D"].map((id) => [l(id).stockDeducted, l(id).procurementQty]), [[2, 0], [0, 2], [1, 0], [0, 1]]);   // A (older) and C (shipped) untouched
  assert.deepEqual([stock("px"), pending("px")], [0, 3]);                                      // quantities untouched
  assert.deepEqual(ledger().map((r) => [r.kind, r.delta, r.sourceId]).sort(), [["RECONCILE_LEGACY_BACKORDER", 0, "li-B"], ["RECONCILE_LEGACY_BACKORDER", 0, "li-D"]]);
  assert.deepEqual((await admin(() => applyLegacyBackorderLinks("a1", 0))), { linkedLines: 0, units: 0 }); // nothing left: idempotent

  // The point of it: a cancelled legacy order no longer creates phantom stock, and receipts now reach these orders.
  await move("B", "CANCELLED");
  assert.deepEqual([stock("px"), pending("px")], [0, 1]);                                      // before: stock 2 (phantom), pending 3
  await path("D", ["CONFIRMED", "PROCESSING"]);
  await assert.rejects(move("D", "SHIPPED"), /still waiting to be sourced/);
  const r = await receiveProcurement({ productId: "px", quantity: 1, adminId: "a1" });
  assert.equal(r.allocatedToOrders, 1);
  await move("D", "SHIPPED");
});

test("legacy backorders: units whose orders already shipped are reported for a manual decision, never silently converted", async () => {
  legacyFixture();
  db.patch("product", "px", { procurementPending: 7 });                                         // 2 more than the open, unshipped lines (5 units) can own
  const report = await admin(() => previewInventoryReconciliation());
  assert.deepEqual([report.totals.unlinkedUnits, report.totals.plannedUnits, report.totals.residualUnits], [7, 5, 2]);
});

test("reconciliation reports lines released before the ledger existed AND restocked by an incident (possible historic double restore)", async () => {
  db.insert("order", { id: "L", orderNumber: "AP-L", status: "REFUNDED", channelId: "channel_website", total: 10, phone: "0" });
  db.insert("orderItem", { id: "li-L", orderId: "L", productId: "p-standard", productName: "Vase", quantity: 2, unitPrice: 5, lineTotal: 10, stockDeducted: 2, stockRestoredAt: new Date(), stockReturnedQty: 2 });
  db.insert("financialIncident", { id: "inc-L", kind: "CUSTOMER_RETURN", occurredOn: new Date(), orderId: "L", orderItemId: "li-L", productId: "p-standard", quantity: 1, stockEffect: "RESTOCK" });
  const report = await admin(() => previewInventoryReconciliation());
  assert.deepEqual(report.anomalies.map((a) => [a.orderNumber, a.code]), [["AP-L", "LEGACY_RELEASE_AND_RESTOCK"]]);
});
