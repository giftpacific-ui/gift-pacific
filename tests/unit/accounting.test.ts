import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinancialSummary, summaryToCsv, type AcctOrder } from "../../src/lib/accounting";

const base: AcctOrder = { id: "o", status: "DELIVERED", channelKind: "WEBSITE", paymentMethod: "COD", fulfillmentMode: "SELF_SHIP", subtotal: 1000, discountTotal: 100, shippingTotal: 120, taxTotal: 0, total: 1020, advancePaid: 0, settlementStatus: "NOT_APPLICABLE", paymentStatus: "UNPAID", items: [{ quantity: 2, lineTotal: 1000, unitCost: 200 }], costLines: [] };
const o = (over: Partial<AcctOrder>): AcctOrder => ({ ...base, ...over });
const S = (orders: AcctOrder[], extra: Partial<Parameters<typeof buildFinancialSummary>[0]> = {}) => buildFinancialSummary({ orders, expenses: [], incidents: [], receipts: [], ...extra });

test("sales, COGS and profit use ONE definition; delivery is revenue, tax is excluded", () => {
  const s = S([o({})]);
  assert.deepEqual([s.grossSales, s.discounts, s.netSales, s.deliveryBilled, s.cogs, s.grossProfit, s.profit], [1000, 100, 900, 120, 400, 500, 620]);
  assert.equal(s.profitIsComplete, true);
  assert.equal(S([o({ taxTotal: 50, total: 1070 })]).profit, 620); // tax never changes profit
});

test("unknown unit cost is never treated as zero: profit is flagged incomplete", () => {
  const s = S([o({ items: [{ quantity: 1, lineTotal: 500, unitCost: null }, { quantity: 1, lineTotal: 500, unitCost: 100 }] })]);
  assert.deepEqual([s.cogs, s.cogsUnknownLines, s.profitIsComplete], [100, 1, false]);
  assert.match(summaryToCsv(s, { from: "2026-01-01", to: "2026-01-31" }), /Estimated profit/);
});

test("cancelled/refunded/failed orders are excluded from sales but their incurred costs and verified advances still count", () => {
  const s = S([o({ status: "FAILED_DELIVERY", advancePaid: 200, costLines: [{ kind: "COURIER_FEE", amount: 130 }] })]);
  assert.deepEqual([s.saleOrders, s.excludedOrders, s.netSales, s.orderCostsTotal, s.advancesReceived], [0, 1, 0, 130, 200]);
  assert.equal(s.profit, -130);
});

test("cash is separate from sales: COD only when delivered, advance counted once, balance not double-counted", () => {
  const delivered = o({ advancePaid: 200, total: 1020 });
  const pipeline = o({ id: "p", status: "PROCESSING", advancePaid: 200, total: 1020 });
  const s = S([delivered, pipeline]);
  assert.deepEqual([s.advancesReceived, s.codCollected, s.codOutstanding, s.cashIn], [400, 820, 820, 1220]); // 400 + 820
  assert.equal(s.orderValue, 2040); // billed value is NOT cash
});

test("marketplace: nothing is cash until a payout is RECORDED; commission is withheld from the payout, not a second cash outgoing", () => {
  const m = o({ channelKind: "MARKETPLACE", paymentMethod: "MARKETPLACE", costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 90 }] });
  const pending = S([m]);
  assert.deepEqual([pending.marketplaceExpectedPayout, pending.marketplaceReceivable, pending.marketplaceSettled, pending.cashIn], [930, 930, 0, 0]);
  const done = S([{ ...m, settlements: [{ amount: 930, receivedOn: "2026-10-05" }] }]);
  assert.deepEqual([done.marketplaceReceivable, done.marketplaceSettled, done.cashIn, done.cashOut, done.netCash], [0, 930, 930, 0, 930]);
  assert.equal(done.marketplaceFeesWithheld, 90);
  assert.equal(done.profit, 620 - 90);                  // the commission still reduces profit exactly once
});
test("incidents: losses and return fees reduce profit; refunds on sale orders are compensation, refunds on excluded orders are cash only", () => {
  const s = S([o({}), o({ id: "r", status: "REFUNDED" })], { incidents: [
    { kind: "DAMAGED_BOX", lossAmount: 50, refundAmount: 0, courierFee: 0, orderCountsAsSale: null },
    { kind: "COURIER_RETURN_FEE", lossAmount: 0, refundAmount: 0, courierFee: 70, orderCountsAsSale: false },
    { kind: "REFUND", lossAmount: 0, refundAmount: 300, courierFee: 0, orderCountsAsSale: false },   // refunded order: cash only
    { kind: "REFUND", lossAmount: 0, refundAmount: 100, courierFee: 0, orderCountsAsSale: true },    // partial refund on a sale
  ] });
  assert.deepEqual([s.incidentLosses, s.incidentCourierFees, s.compensation, s.refundsPaid], [50, 70, 100, 400]);
  assert.equal(s.profit, 620 - 50 - 70 - 100);
  assert.equal(s.cashOut, 400 + 70);
});

test("expenses by category and procurement: purchases are CASH only and never reduce profit", () => {
  const s = S([o({})], { expenses: [{ category: "Rent", amount: 100 }, { category: "Ads", amount: 50.5 }, { category: "Ads", amount: 10 }], receipts: [{ totalCost: 800 }, { totalCost: null }] });
  assert.deepEqual([s.operatingExpenses, s.expensesByCategory.Ads, s.procurementPurchases], [160.5, 60.5, 800]);
  assert.equal(s.profit, 620 - 160.5);
  assert.equal(s.cashOut, 160.5 + 800);
});

test("whole-paisa arithmetic: no floating-point drift", () => {
  const many = Array.from({ length: 1000 }, (_, i) => o({ id: `o${i}`, subtotal: 0.1, discountTotal: 0, shippingTotal: 0.2, total: 0.3, items: [{ quantity: 1, lineTotal: 0.1, unitCost: 0.1 }] }));
  const s = S(many);
  assert.deepEqual([s.grossSales, s.deliveryBilled, s.cogs], [100, 200, 100]);
});
