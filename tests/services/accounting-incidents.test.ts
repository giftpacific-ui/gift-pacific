import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedAdmins, seedCatalog, dhakaDay } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { recordIncident } from "@/server/services/incident.service";
import { getAccounting } from "@/server/services/accounting.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); seedAdmins(db); db.insert("salesChannel", { id: "channel_website", key: "website", name: "Website", kind: "WEBSITE" }); db.insert("salesChannel", { id: "channel_daraz", key: "daraz", name: "Daraz", kind: "MARKETPLACE" }); seedCatalog(db); });
const stock = (id: string) => db.get("product", id).stock as number;
const today = dhakaDay();
const incident = (o: Record<string, unknown>) => recordIncident({ kind: "CUSTOMER_RETURN", occurredOn: today, quantity: 1, stockEffect: "NONE", lossAmount: 0, refundAmount: 0, courierFee: 0, ...o } as never, "a1");

function orderWithLine(status = "FAILED_DELIVERY", qty = 2, restored = false) {
  db.insert("order", { id: "o1", orderNumber: "AP-1", status, total: 500, subtotal: 500, discountTotal: 0, shippingTotal: 0, taxTotal: 0, channelId: "channel_website" });
  db.insert("orderItem", { id: "i1", orderId: "o1", productId: "p-standard", variantId: null, productName: "Vase", quantity: qty, unitPrice: 250, lineTotal: 250 * qty, stockDeducted: qty, stockRestoredAt: restored ? new Date() : null, stockReturnedQty: restored ? qty : 0 });
}

test("restock: returned goods go back exactly once, capped by what is still out", async () => {
  orderWithLine("FAILED_DELIVERY", 2);
  const before = stock("p-standard");
  await incident({ orderItemId: "i1", stockEffect: "RESTOCK", quantity: 1 });
  assert.equal(stock("p-standard"), before + 1);
  await assert.rejects(incident({ orderItemId: "i1", stockEffect: "RESTOCK", quantity: 2 }), /Only 1 unit/);
  await incident({ orderItemId: "i1", stockEffect: "RESTOCK", quantity: 1 });
  await assert.rejects(incident({ orderItemId: "i1", stockEffect: "RESTOCK", quantity: 1 }), /already back/);
  assert.equal(stock("p-standard"), before + 2);
});

test("goods already released by a cancel/refund cannot be restocked again", async () => {
  orderWithLine("REFUNDED", 2, true);
  await assert.rejects(incident({ orderItemId: "i1", stockEffect: "RESTOCK", quantity: 1 }), /already back/);
});

test("write-off removes stock through the guarded decrement and can never go below zero", async () => {
  const have = stock("p-standard");
  await incident({ kind: "UNSELLABLE_WRITE_OFF", productId: "p-standard", stockEffect: "WRITE_OFF", quantity: 1, lossAmount: 40 });
  assert.equal(stock("p-standard"), have - 1);
  await assert.rejects(incident({ kind: "UNSELLABLE_WRITE_OFF", productId: "p-standard", stockEffect: "WRITE_OFF", quantity: have + 5, lossAmount: 40 }), /Not enough stock/);
  assert.equal(stock("p-standard"), have - 1);
});

test("refunds cannot exceed what the order billed in total", async () => {
  orderWithLine("DELIVERED", 1);
  await incident({ kind: "REFUND", orderId: "o1", refundAmount: 300 });
  await assert.rejects(incident({ kind: "REFUND", orderId: "o1", refundAmount: 300 }), /exceed/);
});

test("accounting loader: a refund on a refunded order is cash-only; on a delivered sale it is compensation; both appear once", async () => {
  orderWithLine("REFUNDED", 1);
  db.insert("order", { id: "o2", orderNumber: "AP-2", status: "DELIVERED", total: 500, subtotal: 500, discountTotal: 0, shippingTotal: 0, taxTotal: 0, channelId: "channel_website", paymentMethod: "COD", advancePaid: 0 });
  db.insert("orderItem", { id: "i2", orderId: "o2", productId: "p-standard", productName: "Vase", quantity: 1, unitPrice: 500, lineTotal: 500, unitCost: 200 });
  await incident({ kind: "REFUND", orderId: "o1", refundAmount: 500 });
  await incident({ kind: "REFUND", orderId: "o2", refundAmount: 100 });
  const { summary } = await runAs("admin", () => getAccounting({ from: today, to: today }));
  assert.deepEqual([summary.refundsPaid, summary.compensation, summary.refundedOrdersWithoutRefundRecord], [600, 100, 0]);
  assert.equal(summary.netSales, 500);
  assert.equal(summary.profit, 500 - 200 - 100);
});
