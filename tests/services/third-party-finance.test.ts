import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedCatalog, dhakaDay, seedAdmins, TEST_ADMIN } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { createExternalOrder, adminAddOrderCostLine, adminDeleteOrderCostLine } from "@/server/services/external-order.service";
import { recordSettlement, listOpenReceivables } from "@/server/services/settlement.service";
import { verifyAdvancePayment } from "@/server/services/advance.service";
import { recordIncident } from "@/server/services/incident.service";
import { adminUpdateOrderStatus } from "@/server/services/order.service";
import { getAccounting } from "@/server/services/accounting.service";
import { getChannelReport } from "@/server/services/channel-report.service";
import { getSalesReport } from "@/server/services/admin-report.service";
import { getAdminDashboardStats } from "@/server/services/admin-dashboard.service";
import { ordersFinancialCsv } from "@/lib/accounting";
import { parseReportRange } from "@/lib/report";
import { GET as accountsExport } from "@/app/admin/(dashboard)/accounts/export/route";

let db: FakeDb;
const admin = <T,>(fn: () => Promise<T>) => runAs("admin", fn);
const stock = (id: string) => db.get("product", id).stock as number;
const today = dhakaDay();
const yesterday = dhakaDay(-1);

beforeEach(() => {
  db = freshDb(); seedAdmins(db);
  seedCatalog(db); // Clay Vase: stock 5, cost 700
  db.insert("salesChannel", { id: "channel_website", key: "website", name: "Website", kind: "WEBSITE" });
  db.insert("salesChannel", { id: "channel_daraz", key: "daraz", name: "Daraz", kind: "MARKETPLACE" });
  db.insert("salesChannel", { id: "channel_fb", key: "facebook", name: "Facebook Shop", kind: "OTHER" });
});

// 2 vases at 1500 + 60 shipping = 3060
const order = (over: Record<string, unknown> = {}) => ({
  channelId: "channel_daraz", externalOrderRef: "d-1001",
  customer: { fullName: "Jo Doe", phone: "01711000000", line1: "House 1, Road 2" },
  items: [{ productId: "p-standard", quantity: 2, unitPrice: 1500 }], shippingTotal: 60,
  costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 100 }], ...over,
});
const settle = (orderId: string, over: Record<string, unknown> = {}) => admin(() => recordSettlement({ orderId, amount: 100, receivedOn: yesterday, reference: "PAY-1", ...over }, "admin-1"));
const accounts = () => admin(() => getAccounting({ from: yesterday, to: today }));

// ---- advance + remaining balance --------------------------------------------------------------------------------------------------
test("advance + balance: a partial advance on a third-party order is PARTIALLY_PAID (even when the form said PAID); only the advance is cash", async () => {
  const r = await admin(() => createExternalOrder(order({ channelId: "channel_fb", costLines: [], paymentStatus: "PAID", status: "CONFIRMED", advanceReceived: 500, advanceMethod: "BKASH", advanceReference: " tx-9a8b7c " }), "admin-1"));
  const o = db.get("order", r.id);
  assert.deepEqual([o.paymentStatus, Number(o.advancePaid), Number(o.total)], ["PARTIALLY_PAID", 500, 3060]);
  const [pay] = db.rows("payment");
  assert.deepEqual([pay.status, pay.kind, pay.providerRef, pay.method, Number(pay.amount)], ["PAID", "ADVANCE", "TX9A8B7C", "BKASH", 500]);
  const s = (await accounts()).summary;
  assert.deepEqual([s.advancesReceived, s.codOutstanding, s.codCollected, s.cashIn, s.orderValue], [500, 2560, 0, 500, 3060]);
});

test("advance + balance: delivery collects ONLY the remaining balance; the advance is not counted twice", async () => {
  const r = await admin(() => createExternalOrder(order({ channelId: "channel_fb", costLines: [], advanceReceived: 500, advanceMethod: "COD" }), "admin-1"));
  await admin(() => adminUpdateOrderStatus(r.id, "PROCESSING", undefined, TEST_ADMIN)).catch(() => undefined);
  db.tables.order.find((x) => x.id === r.id)!.status = "DELIVERED";
  const s = (await accounts()).summary;
  assert.deepEqual([s.advancesReceived, s.codCollected, s.cashIn, s.codOutstanding], [500, 2560, 3060, 0]);
});

test("no advance on a non-marketplace channel: a 'paid' claim is not accepted as money", async () => {
  const r = await admin(() => createExternalOrder(order({ channelId: "channel_fb", costLines: [], paymentStatus: "PAID" }), null));
  assert.equal(db.get("order", r.id).paymentStatus, "UNPAID");
  assert.equal((await accounts()).summary.cashIn, 0);
});

// ---- duplicate transaction reference ---------------------------------------------------------------------------------------------
test("duplicate transaction reference: the same wallet transaction (any spelling) cannot be recorded twice; nothing is deducted for the refused order", async () => {
  await admin(() => createExternalOrder(order({ channelId: "channel_fb", costLines: [], advanceReceived: 500, advanceMethod: "BKASH", advanceReference: "8N7A6D5EE7" }), null));
  const stockAfterFirst = stock("p-standard");
  for (const ref of ["8n7a6d5ee7", " 8N7A-6D5EE7 ", "8n7a 6d5ee7"]) {
    await assert.rejects(admin(() => createExternalOrder(order({ channelId: "channel_fb", externalOrderRef: `F-${ref.length}`, costLines: [], advanceReceived: 300, advanceMethod: "BKASH", advanceReference: ref }), null)), /already been recorded on order AP-/);
  }
  assert.equal(db.rows("order").length, 1);
  assert.equal(db.rows("payment").length, 1);
  assert.equal(stock("p-standard"), stockAfterFirst);
  // the same id on ANOTHER wallet is a different transaction
  await admin(() => createExternalOrder(order({ channelId: "channel_fb", externalOrderRef: "F-NAGAD", costLines: [], advanceReceived: 300, advanceMethod: "NAGAD", advanceReference: "8N7A6D5EE7" }), null));
  assert.equal(db.rows("payment").length, 2);
});

test("duplicate transaction reference: a reference still held by a payment is blocked even if that payment's order record is gone", async () => {
  db.insert("payment", { id: "orphan", orderId: "gone", method: "BKASH", status: "PAID", amount: 1, providerRef: "RACE1234" });
  await assert.rejects(admin(() => createExternalOrder(order({ channelId: "channel_fb", costLines: [], advanceReceived: 300, advanceMethod: "BKASH", advanceReference: "race1234" }), null)), /Transaction RACE1234 \(BKASH\) has already been recorded/);
  assert.equal(db.rows("order").length, 0);
});

test("website advance verification uses the same normalisation: a transaction already counted on another order is refused, and over-verifying is refused instead of clamped", async () => {
  await admin(() => createExternalOrder(order({ channelId: "channel_fb", costLines: [], advanceReceived: 500, advanceMethod: "BKASH", advanceReference: "WALLET-TX-1" }), null));
  db.insert("order", { id: "w1", orderNumber: "AP-W1", channelId: "channel_website", status: "PENDING", total: 1000, subtotal: 1000, phone: "0", advanceRequired: 200 });
  db.insert("payment", { id: "claim", orderId: "w1", method: "BKASH", status: "PENDING", kind: "ADVANCE", amount: 200, customerReference: "wallet tx 1" });
  await assert.rejects(admin(() => verifyAdvancePayment({ paymentId: "claim", adminId: "a1", providerRef: "wallet tx 1", amount: 200 })), /already been used/);
  await assert.rejects(admin(() => verifyAdvancePayment({ paymentId: "claim", adminId: "a1", providerRef: "FRESH-TX-9", amount: 1200 })), /more than this order's total/);
  assert.equal(Number(db.get("order", "w1").advancePaid), 0);
  assert.equal(db.get("payment", "claim").status, "PENDING");
});

test("a pending customer claim appears as an unverified claim — not cash, not a reduced balance — until an admin verifies it", async () => {
  db.insert("order", { id: "w2", orderNumber: "AP-W2", channelId: "channel_website", status: "PENDING", total: 1000, subtotal: 1000, shippingTotal: 0, discountTotal: 0, taxTotal: 0, phone: "0", advanceRequired: 200, createdAt: new Date() });
  db.insert("payment", { id: "c2", orderId: "w2", method: "BKASH", status: "PENDING", kind: "ADVANCE", amount: 200, customerReference: "CUSTOMER-TX" });
  let s = (await accounts()).summary;
  assert.deepEqual([s.unverifiedClaims, s.unverifiedClaimCount, s.advancesReceived, s.cashIn, s.codOutstanding], [200, 1, 0, 0, 1000]);
  await admin(() => verifyAdvancePayment({ paymentId: "c2", adminId: "a1", providerRef: "REAL-TX-77", amount: 200 }));
  s = (await accounts()).summary;
  assert.deepEqual([s.unverifiedClaims, s.advancesReceived, s.cashIn, s.codOutstanding], [0, 200, 200, 800]);
});

// ---- marketplace settlement --------------------------------------------------------------------------------------------------------
test("a new marketplace order is a receivable: expected = total − commission; no cash until a payout is recorded", async () => {
  const r = await admin(() => createExternalOrder(order(), null));
  assert.equal(db.get("order", r.id).settlementStatus, "PENDING");
  const s = (await accounts()).summary;
  assert.deepEqual([s.marketplaceExpectedPayout, s.marketplaceReceivable, s.marketplaceSettled, s.cashIn, s.profit], [2960, 2960, 0, 0, 3000 + 60 - 1400 - 100]);
  const [rec] = await listOpenReceivables();
  assert.deepEqual([rec.expected, rec.received, rec.remaining, rec.state], [2960, 0, 2960, "PENDING"]);
});

test("partial then full settlement: status follows the real amounts; the remainder stays receivable", async () => {
  const r = await admin(() => createExternalOrder(order(), null));
  const first = await settle(r.id, { amount: 1000, reference: "PAY-1" });
  assert.deepEqual([first.state, first.remaining, first.duplicate], ["PARTIAL", 1960, false]);
  assert.equal(db.get("order", r.id).settlementStatus, "PARTIAL");
  assert.equal(db.get("order", r.id).settledAt, null);
  let s = (await accounts()).summary;
  assert.deepEqual([s.marketplaceSettled, s.marketplaceReceivable, s.marketplacePartialOrders, s.cashIn], [1000, 1960, 1, 1000]);
  assert.equal((await listOpenReceivables())[0].state, "PARTIAL");
  const second = await settle(r.id, { amount: 1960, reference: "PAY-2", receivedOn: today });
  assert.deepEqual([second.state, second.remaining], ["SETTLED", 0]);
  assert.notEqual(db.get("order", r.id).settledAt, null);
  s = (await accounts()).summary;
  assert.deepEqual([s.marketplaceSettled, s.marketplaceReceivable, s.cashIn, s.marketplacePartialOrders], [2960, 0, 2960, 0]);
  assert.equal((await listOpenReceivables()).length, 0);
});

test("advance + settlement: the payout excludes the advance; cash = advance + payout; no double count", async () => {
  const r = await admin(() => createExternalOrder(order({ advanceReceived: 500, advanceMethod: "COD" }), null));
  assert.equal((await accounts()).summary.marketplaceExpectedPayout, 2460);                  // 3060 − 500 − 100
  await assert.rejects(settle(r.id, { amount: 2961 }), /more than Daraz still owes/);
  await settle(r.id, { amount: 2460 });
  const s = (await accounts()).summary;
  assert.deepEqual([s.advancesReceived, s.marketplaceSettled, s.cashIn, s.marketplaceReceivable, s.cashOut, s.netCash], [500, 2460, 2960, 0, 0, 2960]);
  assert.equal(s.cashIn + s.marketplaceFeesWithheld, s.orderValue);
});

test("a payout recorded when the order is entered creates the payout row in the same transaction; a payout above the expected amount is refused", async () => {
  const r = await admin(() => createExternalOrder(order({ settlementReceived: 1000, settlementReceivedOn: yesterday, settlementReference: "stmt 5" }), null));
  const [row] = db.rows("marketplaceSettlement");
  assert.deepEqual([row.orderId, Number(row.amount), row.reference], [r.id, 1000, "STMT5"]);
  assert.equal(db.get("order", r.id).settlementStatus, "PARTIAL");
  await assert.rejects(admin(() => createExternalOrder(order({ externalOrderRef: "d-2", settlementReceived: 3000, settlementReceivedOn: yesterday }), null)), /more than the expected payout/);
  await assert.rejects(admin(() => createExternalOrder(order({ externalOrderRef: "d-3", channelId: "channel_fb", costLines: [], settlementReceived: 100, settlementReceivedOn: yesterday }), null)), /marketplace channel/);
  assert.equal(db.rows("order").length, 1);
});

test("duplicate settlement entries are prevented: same reference, identical amount+date without reference, double submit, retry key", async () => {
  const r = await admin(() => createExternalOrder(order(), null));
  await settle(r.id, { amount: 500, reference: "pay 1" });
  await assert.rejects(settle(r.id, { amount: 500, reference: "PAY-1".replace("-", "") }), /already recorded/);          // same reference in another spelling
  await settle(r.id, { amount: 300, reference: undefined, receivedOn: yesterday });
  await assert.rejects(settle(r.id, { amount: 300, reference: undefined, receivedOn: yesterday }), /identical payout/);   // no reference: same amount + date
  // idempotency: a retried submit with the same key is a no-op that returns the original entry
  const a = await settle(r.id, { amount: 200, reference: "PAY-3", idempotencyKey: "key-1" });
  const b = await settle(r.id, { amount: 200, reference: "PAY-3", idempotencyKey: "key-1" });
  assert.deepEqual([a.duplicate, b.duplicate, b.id], [false, true, a.id]);
  assert.equal(db.rows("marketplaceSettlement").length, 3);
  await assert.rejects(settle("another", { amount: 1, idempotencyKey: "key-1" }), /Order not found|different order/);
  assert.equal(Number((await accounts()).summary.marketplaceSettled), 1000);
});

test("two payouts submitted at the same moment cannot together exceed the expected payout", async () => {
  const r = await admin(() => createExternalOrder(order(), null));
  const results = await Promise.allSettled([settle(r.id, { amount: 1800, reference: "A-1", idempotencyKey: "k-a" }), settle(r.id, { amount: 1800, reference: "B-1", idempotencyKey: "k-b" })]);
  assert.deepEqual(results.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(db.rows("marketplaceSettlement").length, 1);
  assert.equal((await accounts()).summary.marketplaceSettled, 1800);
});

test("settlement validation and eligibility are enforced on the server", async () => {
  const web = db.insert("order", { id: "w9", orderNumber: "AP-W9", channelId: "channel_website", status: "DELIVERED", total: 500, phone: "0" });
  const m = await admin(() => createExternalOrder(order(), null));
  for (const [bad, msg] of [[{ amount: 0 }, /amount/], [{ amount: -1 }, /amount/], [{ amount: 1.001 }, /amount/], [{ receivedOn: "2999-01-01" }, /future/], [{ receivedOn: "nope" }, /date/]] as [Record<string, unknown>, RegExp][]) {
    await assert.rejects(settle(m.id, bad), msg, JSON.stringify(bad));
  }
  await assert.rejects(settle(web.id as string), /only recorded for marketplace/);
  await admin(() => adminUpdateOrderStatus(m.id, "CANCELLED", undefined, TEST_ADMIN));
  await assert.rejects(settle(m.id), /no longer counts as a sale/);
  assert.equal(db.rows("marketplaceSettlement").length, 0);
});

test("cost lines drive the expected payout: correcting the commission re-derives the status; a missing commission makes profit an estimate", async () => {
  const r = await admin(() => createExternalOrder(order({ costLines: [] }), null));
  let s = (await accounts()).summary;
  assert.deepEqual([s.profitIsComplete, s.commissionMissingOrders, s.marketplaceExpectedPayout], [false, 1, 3060]);
  await admin(() => adminAddOrderCostLine(r.id, { kind: "MARKETPLACE_COMMISSION", amount: 160 }, null));
  s = (await accounts()).summary;
  assert.deepEqual([s.profitIsComplete, s.marketplaceExpectedPayout, s.marketplaceFeesWithheld], [true, 2900, 160]);
  await settle(r.id, { amount: 2900 });
  assert.equal(db.get("order", r.id).settlementStatus, "SETTLED");
  // the marketplace actually withheld more than first recorded: a second commission line lowers the expectation; the extra payout is disclosed
  await admin(() => adminAddOrderCostLine(r.id, { kind: "MARKETPLACE_COMMISSION", amount: 40 }, null));
  s = (await accounts()).summary;
  assert.deepEqual([s.marketplaceExpectedPayout, s.marketplaceReceivable, s.marketplaceOverReceived], [2860, 0, 40]);
  const line = db.rows("orderCostLine").find((c) => Number(c.amount) === 40)!;
  await admin(() => adminDeleteOrderCostLine(r.id, line.id as string));
  assert.equal((await accounts()).summary.marketplaceOverReceived, 0);
});

// ---- inventory, returns, refunds ------------------------------------------------------------------------------------------------------
test("stock: a third-party order deducts like an ordinary one; cancelling restores once, removes the receivable, and keeps recorded payouts as cash", async () => {
  const r = await admin(() => createExternalOrder(order(), null));
  assert.equal(stock("p-standard"), 3);
  await settle(r.id, { amount: 500 });
  await admin(() => adminUpdateOrderStatus(r.id, "CANCELLED", undefined, TEST_ADMIN));
  assert.equal(stock("p-standard"), 5);
  await admin(() => adminUpdateOrderStatus(r.id, "CANCELLED", undefined, TEST_ADMIN)).catch(() => undefined);
  assert.equal(stock("p-standard"), 5);                                                        // never restored twice
  const s = (await accounts()).summary;
  assert.deepEqual([s.saleOrders, s.marketplaceReceivable, s.marketplaceExpectedPayout, s.cogs, s.marketplaceSettled], [0, 0, 0, 0, 500]);
});

test("returns and stock cost: restocked goods are no loss; a write-off is a loss counted once and takes stock out; a refund on a sale is compensation", async () => {
  const r = await admin(() => createExternalOrder(order({ channelId: "channel_fb", externalOrderRef: "F-1", costLines: [], advanceReceived: 500, advanceMethod: "COD", status: "DELIVERED" }), null));
  const line = db.rows("orderItem")[0];
  const before = (await accounts()).summary;
  assert.equal(before.profit, 3000 + 60 - 1400);
  await admin(() => recordIncident({ kind: "REFUND", occurredOn: today, orderId: r.id, quantity: 0, stockEffect: "NONE", lossAmount: 0, refundAmount: 200, courierFee: 0 }, "a1"));
  await admin(() => recordIncident({ kind: "UNSELLABLE_WRITE_OFF", occurredOn: today, productId: "p-standard", quantity: 1, stockEffect: "WRITE_OFF", lossAmount: 700, refundAmount: 0, courierFee: 0 }, "a1"));
  assert.equal(stock("p-standard"), 2);
  const s = (await accounts()).summary;
  assert.deepEqual([s.compensation, s.incidentLosses, s.refundsPaid, s.profit], [200, 700, 200, 3000 + 60 - 1400 - 200 - 700]);
  // returned goods that are fine go back to stock with NO loss, only once
  db.tables.order.find((x) => x.id === r.id)!.status = "FAILED_DELIVERY";
  await admin(() => recordIncident({ kind: "CUSTOMER_RETURN", occurredOn: today, orderItemId: line.id as string, quantity: 1, stockEffect: "RESTOCK", lossAmount: 0, refundAmount: 0, courierFee: 0 }, "a1"));
  assert.equal(stock("p-standard"), 3);
  await assert.rejects(admin(() => recordIncident({ kind: "CUSTOMER_RETURN", occurredOn: today, orderItemId: line.id as string, quantity: 2, stockEffect: "RESTOCK", lossAmount: 0, refundAmount: 0, courierFee: 0 }, "a1")), /Only 1 unit/);
  assert.equal((await accounts()).summary.incidentLosses, 700);
});

// ---- parity across surfaces -----------------------------------------------------------------------------------------------------------
test("one definition set: Accounts, dashboard, channel report, sales report, CSV summary and per-order CSV all agree", async () => {
  db.tables.product.find((p) => p.id === "p-standard")!.stock = 20;
  const m1 = await admin(() => createExternalOrder(order({ externalOrderRef: "d-1", advanceReceived: 500, advanceMethod: "COD" }), null));
  await settle(m1.id, { amount: 1000, reference: "P-1" });
  await admin(() => createExternalOrder(order({ externalOrderRef: "d-2", costLines: [] }), null));          // missing commission → estimate
  await admin(() => createExternalOrder(order({ channelId: "channel_fb", externalOrderRef: "f-1", costLines: [{ kind: "COURIER_FEE", amount: 80 }], advanceReceived: 300, advanceMethod: "BKASH", advanceReference: "PARITY-TX-1" }), null));
  db.insert("order", { id: "w1", orderNumber: "AP-W1", channelId: "channel_website", status: "DELIVERED", paymentStatus: "PAID", subtotal: 1800, discountTotal: 0, shippingTotal: 70, taxTotal: 0, total: 1870, createdAt: new Date(), phone: "0" });
  db.insert("orderItem", { id: "w1i", orderId: "w1", productId: "p-standard", productName: "Clay Vase", unitPrice: 1800, quantity: 1, lineTotal: 1800, unitCost: 700 });
  db.insert("expense", { id: "e1", spentOn: new Date(`${today}T00:00:00Z`), category: "Ads", amount: 250 });
  await admin(() => recordIncident({ kind: "UNSELLABLE_WRITE_OFF", occurredOn: today, productId: "p-standard", quantity: 1, stockEffect: "WRITE_OFF", lossAmount: 90, refundAmount: 0, courierFee: 0 }, "a1"));

  const acct = await accounts();
  const s = acct.summary;
  assert.equal(s.profitIsComplete, false);

  // dashboard (this month) vs Accounts for the dashboard's own range
  const dash = await admin(() => getAdminDashboardStats());
  const same = await admin(() => getAccounting({ from: dash.financeRange.from, to: dash.financeRange.to }));
  assert.deepEqual(dash.finance, same.summary);
  assert.equal(dash.revenueByDay.reduce((a, d) => a + d.total, 0), same.summary.orderValue);

  // channel report (no filters) combined == Accounts
  const ch = await admin(() => getChannelReport({ from: yesterday, to: today }));
  assert.deepEqual([ch.combined.revenue, ch.combined.collected, ch.combined.netProfitEstimate, ch.combined.marketplaceReceivable, ch.combined.profitIsComplete, ch.combined.unverifiedClaims],
    [s.orderValue, s.cashIn, s.profit, s.marketplaceReceivable, s.profitIsComplete, s.unverifiedClaims]);
  assert.equal(ch.channels.reduce((a, c) => a + c.revenue, 0), s.orderValue);

  // sales report uses the same orders and the same order value
  const sales = await admin(() => getSalesReport(parseReportRange(yesterday, today)));
  assert.equal(sales.report.netRevenue, s.orderValue);
  assert.equal(sales.report.salesCount, s.saleOrders);

  // per-order CSV TOTAL row == summary
  const csvRows = ordersFinancialCsv(acct.orders).trim().split("\r\n");
  const total = csvRows[csvRows.length - 1].split(",");
  assert.deepEqual([Number(total[6]), Number(total[7]), Number(total[13]), Number(total[14]), Number(total[20])], [s.orderValue, s.advancesReceived, s.marketplaceSettled, s.marketplaceReceivable, s.orderMargin]);

  // the HTTP routes return exactly those numbers
  const summaryCsv = await admin(async () => (await accountsExport(new Request(`http://x/admin/accounts/export?from=${yesterday}&to=${today}`))).text());
  assert.match(summaryCsv, new RegExp(`Order value billed,${s.orderValue}\\r`));
  assert.match(summaryCsv, new RegExp(`Cash in,${s.cashIn}\\r`));
  assert.match(summaryCsv, new RegExp(`Marketplace receivable remaining,${s.marketplaceReceivable}\\r`));
  assert.match(summaryCsv, /Estimated profit/);
  const ordersCsvBody = await admin(async () => (await accountsExport(new Request(`http://x/admin/accounts/export?type=orders&from=${yesterday}&to=${today}`))).text());
  assert.match(ordersCsvBody, /\r\nTOTAL,/);
  assert.equal((await accountsExport(new Request("http://x/admin/accounts/export"))).status, 403);        // admin only
});
