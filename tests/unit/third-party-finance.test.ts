import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinancialSummary, orderFacts, ordersFinancialCsv, orderValueByDay, summaryToCsv, type AcctOrder } from "@/lib/accounting";
import { expectedPayoutPaisa, settlementState, validateSettlementInput } from "@/lib/settlement";
import { normalizeTxnRef } from "@/lib/payment-reference";
import { externalPaymentStatus, parseExternalOrderInput } from "@/lib/external-order";
import { aggregateChannelReport } from "@/lib/channel-report";

const base: AcctOrder = { id: "o", status: "DELIVERED", channelKind: "WEBSITE", paymentMethod: "COD", fulfillmentMode: "SELF_SHIP", subtotal: 1000, discountTotal: 0, shippingTotal: 60, taxTotal: 0, total: 1060, advancePaid: 0, paymentStatus: "UNPAID", items: [{ quantity: 2, lineTotal: 1000, unitCost: 300 }], costLines: [] };
const o = (over: Partial<AcctOrder>): AcctOrder => ({ ...base, ...over });
const S = (orders: AcctOrder[], extra: Partial<Parameters<typeof buildFinancialSummary>[0]> = {}) => buildFinancialSummary({ orders, expenses: [], incidents: [], receipts: [], ...extra });
const market = (over: Partial<AcctOrder> = {}) => o({ channelKind: "MARKETPLACE", paymentMethod: "MARKETPLACE", costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 100 }], ...over });

// ---- A. advance + remaining balance --------------------------------------------------------------------------------------------
test("advance plus remaining balance: the advance is counted once; the order is only fully collected when delivered", () => {
  const inFlight = S([o({ status: "PROCESSING", advancePaid: 300 })]);
  assert.deepEqual([inFlight.advancesReceived, inFlight.codCollected, inFlight.codOutstanding, inFlight.cashIn], [300, 0, 760, 300]);
  const delivered = S([o({ advancePaid: 300 })]);
  assert.deepEqual([delivered.advancesReceived, delivered.codCollected, delivered.codOutstanding, delivered.cashIn], [300, 760, 0, 1060]); // 300 + 760, never 300 + 1060
});

test("a payment-status LABEL is never cash: PAID with no verified money and not delivered collects nothing", () => {
  const s = S([o({ status: "CONFIRMED", paymentStatus: "PAID", advancePaid: 0 })]);
  assert.deepEqual([s.cashIn, s.codCollected, s.codOutstanding], [0, 0, 1060]);
});

test("unverified claims are shown separately: never cash, never reduce the balance owed, ignored on excluded orders", () => {
  const s = S([o({ status: "PENDING", pendingClaims: [200] }), o({ id: "x", status: "CANCELLED", pendingClaims: [500] })]);
  assert.deepEqual([s.unverifiedClaims, s.unverifiedClaimCount, s.cashIn, s.codOutstanding], [200, 1, 0, 1060]);
});

// ---- B. marketplace settlement --------------------------------------------------------------------------------------------------
test("expected payout = total − advance paid to us − commission/payment fee withheld (never below 0)", () => {
  assert.equal(expectedPayoutPaisa({ total: 1060, advancePaid: 0, costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 100 }] }), 96000);
  assert.equal(expectedPayoutPaisa({ total: 1060, advancePaid: 300, costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 100 }, { kind: "PAYMENT_FEE", amount: 10.5 }, { kind: "COURIER_FEE", amount: 70 }] }), 64950); // courier is ours, not withheld
  assert.equal(expectedPayoutPaisa({ total: 100, advancePaid: 100, costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 50 }] }), 0);
  assert.deepEqual([settlementState(96000, 0), settlementState(96000, 50000), settlementState(96000, 96000), settlementState(0, 0)], ["PENDING", "PARTIAL", "SETTLED", "SETTLED"]);
});

test("partial then full settlement: the remainder stays receivable and cash is only what was recorded", () => {
  const m = market();
  assert.deepEqual([S([m]).marketplaceReceivable, S([m]).cashIn], [960, 0]);
  const partial = S([{ ...m, settlements: [{ amount: 400, receivedOn: "2026-10-03" }] }]);
  assert.deepEqual([partial.marketplaceSettled, partial.marketplaceReceivable, partial.marketplacePartialOrders, partial.cashIn], [400, 560, 1, 400]);
  const full = S([{ ...m, settlements: [{ amount: 400, receivedOn: "2026-10-03" }, { amount: 560, receivedOn: "2026-10-09" }] }]);
  assert.deepEqual([full.marketplaceSettled, full.marketplaceReceivable, full.marketplacePartialOrders, full.cashIn], [960, 0, 0, 960]);
  assert.equal(orderFacts({ ...m, settlements: [{ amount: 960 }] }).settlement, "SETTLED");
});

test("advance plus settlement is never double-counted: cash = advance + payout, payout excludes what the customer already paid us", () => {
  const m = market({ advancePaid: 300, settlements: [{ amount: 660 }] }); // 1060 − 300 − 100
  const s = S([m]);
  assert.deepEqual([s.marketplaceExpectedPayout, s.marketplaceReceivable, s.advancesReceived, s.marketplaceSettled, s.cashIn], [660, 0, 300, 660, 960]);
  assert.equal(s.cashIn + s.marketplaceFeesWithheld, 1060);                // cash + withheld commission = the whole order value, exactly once
  assert.equal(s.cashOut, 0);                                              // commission was withheld, not paid again
});

test("a marketplace payout is not cash until recorded, and a partial payout is not assumed to be the whole", () => {
  const s = S([market({ settlements: [{ amount: 10 }] })]);
  assert.equal(s.marketplaceSettled, 10);
  assert.equal(s.marketplaceReceivable, 950);
  assert.equal(S([market()]).cashIn, 0);
});

test("courier/packaging on a marketplace order are still cash we pay; only commission/payment fee are withheld", () => {
  const s = S([market({ settlements: [{ amount: 960 }], costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 100 }, { kind: "COURIER_FEE", amount: 70 }] })]);
  assert.deepEqual([s.orderCostsTotal, s.marketplaceFeesWithheld, s.courierOrderCosts, s.cashOut], [170, 100, 70, 70]);
});

test("a cancelled marketplace order is no receivable, but a payout that really arrived stays cash", () => {
  const s = S([market({ status: "CANCELLED", settlements: [{ amount: 200 }] })]);
  assert.deepEqual([s.saleOrders, s.marketplaceReceivable, s.marketplaceExpectedPayout, s.marketplaceSettled], [0, 0, 0, 200]);
});

test("payouts above the (later corrected) expected amount are disclosed, not silently dropped", () => {
  const s = S([market({ settlements: [{ amount: 1000 }] })]);
  assert.deepEqual([s.marketplaceReceivable, s.marketplaceOverReceived, s.marketplaceSettled], [0, 40, 1000]);
});

test("payouts back-filled from the old SETTLED flag are disclosed as assumed", () => {
  assert.equal(S([market({ settlements: [{ amount: 960, legacyAssumed: true }] })]).marketplaceLegacyAssumed, 960);
});

// ---- missing costs --------------------------------------------------------------------------------------------------------------
test("missing unit cost or missing marketplace commission makes profit INCOMPLETE with reasons; an explicit 0 commission completes it", () => {
  const unknownCost = S([o({ items: [{ quantity: 1, lineTotal: 1000, unitCost: null }] })]);
  assert.equal(unknownCost.profitIsComplete, false);
  assert.match(unknownCost.profitIncompleteReasons.join(";"), /no unit cost/);
  const noCommission = S([market({ costLines: [] })]);
  assert.deepEqual([noCommission.profitIsComplete, noCommission.commissionMissingOrders], [false, 1]);
  assert.match(noCommission.profitIncompleteReasons.join(";"), /commission/);
  assert.equal(S([market({ costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 0 }] })]).profitIsComplete, true);
  assert.equal(S([o({ channelKind: "OTHER" })]).profitIsComplete, true);   // non-marketplace channels need no commission
  assert.match(summaryToCsv(noCommission, { from: "2026-10-01", to: "2026-10-31" }), /Estimated profit[\s\S]*Incomplete: 1 sold marketplace order/);
});

// ---- refunds / returns / stock-cost -----------------------------------------------------------------------------------------------
test("refunded order: revenue and COGS leave sales (goods returned to stock are no loss); the refund moves cash; a write-off is the only loss", () => {
  const refunded = o({ status: "REFUNDED", advancePaid: 300 });
  const s = S([o({}), refunded], { incidents: [
    { kind: "REFUND", lossAmount: 0, refundAmount: 300, courierFee: 0, orderCountsAsSale: false },
    { kind: "UNSELLABLE_WRITE_OFF", lossAmount: 150, refundAmount: 0, courierFee: 0, orderCountsAsSale: null },
  ] });
  assert.deepEqual([s.saleOrders, s.excludedOrders, s.cogs, s.incidentLosses, s.compensation, s.refundsPaid], [1, 1, 600, 150, 0, 300]);
  assert.equal(s.profit, 1000 + 60 - 600 - 150);            // 310: refunded order contributes nothing, the write-off is counted once
  assert.equal(s.advancesReceived, 300);                      // the advance was real cash...
  assert.equal(s.cashOut, 300);                               // ...and the refund returns exactly that cash
});

test("procurement purchase is cash only; the same goods are costed once through COGS", () => {
  const s = S([o({})], { receipts: [{ totalCost: 800 }] });
  assert.deepEqual([s.procurementPurchases, s.cogs, s.profit, s.cashOut], [800, 600, 1000 + 60 - 600, 800]);
});

test("delivery charged (income) and courier costs (expense) are separate lines and never netted", () => {
  const s = S([o({ costLines: [{ kind: "COURIER_FEE", amount: 90 }] })]);
  assert.deepEqual([s.deliveryBilled, s.courierOrderCosts, s.profit], [60, 90, 1000 + 60 - 600 - 90]);
});

// ---- CSV and report parity --------------------------------------------------------------------------------------------------------
test("per-order CSV TOTAL row equals the summary built from the same orders", () => {
  const orders = [
    o({ id: "a", orderNumber: "AP-1", status: "PROCESSING", advancePaid: 300, pendingClaims: [50] }),
    o({ id: "b", orderNumber: "AP-2" }),
    market({ id: "c", orderNumber: "AP-3", advancePaid: 200, settlements: [{ amount: 300, receivedOn: "2026-10-04" }] }),
    market({ id: "d", orderNumber: "AP-4", status: "CANCELLED", settlements: [{ amount: 50 }], costLines: [{ kind: "COURIER_FEE", amount: 40 }] }),
    o({ id: "e", orderNumber: "AP-5", items: [{ quantity: 1, lineTotal: 1000, unitCost: null }] }),
  ];
  const s = S(orders);
  const rows = ordersFinancialCsv(orders).trim().split("\r\n");
  const total = rows[rows.length - 1].split(",");
  const col = (name: string) => Number(total[["Order number", "Channel", "External ref", "Placed on", "Status", "Counted as sale", "Order value billed", "Verified advance", "Unverified claim (not cash)", "COD collected", "Customer balance outstanding", "Marketplace fees withheld", "Expected payout", "Payout received", "Receivable remaining", "Settlement", "Payout dates", "Cost of goods sold", "Lines without cost", "All order costs", "Order margin"].indexOf(name)]);
  assert.deepEqual(
    [col("Order value billed"), col("Verified advance"), col("Unverified claim (not cash)"), col("COD collected"), col("Customer balance outstanding"), col("Marketplace fees withheld"), col("Expected payout"), col("Payout received"), col("Receivable remaining"), col("Cost of goods sold"), col("Lines without cost"), col("All order costs"), col("Order margin")],
    [s.orderValue, s.advancesReceived, s.unverifiedClaims, s.codCollected, s.codOutstanding, s.marketplaceFeesWithheld, s.marketplaceExpectedPayout, s.marketplaceSettled, s.marketplaceReceivable, s.cogs, s.cogsUnknownLines, s.orderCostsTotal, s.orderMargin],
  );
  assert.equal(s.orderMargin, s.grossProfit + s.deliveryBilled - s.orderCostsTotal);   // the identity linking the per-order rows to the profit formula
  assert.equal(rows.length, orders.length + 2);                                       // header + orders + TOTAL
});

test("CSV never lets text be read as a formula but keeps negative numbers intact", () => {
  const csv = ordersFinancialCsv([o({ orderNumber: "=cmd()", status: "CANCELLED", costLines: [{ kind: "COURIER_FEE", amount: 40 }] })]);
  assert.match(csv, /'=cmd\(\)/);
  assert.match(csv, /,-40,/);                                                           // order margin of a cancelled order with a courier cost
});

test("channel report is the shared summary per channel: combined equals the Accounts summary; channels + unassigned add up", () => {
  const channels = [{ id: "w", name: "Website", kind: "WEBSITE" as const }, { id: "d", name: "Daraz", kind: "MARKETPLACE" as const }];
  const orders = [
    { ...o({ id: "1", advancePaid: 300 }), channelId: "w" },
    { ...market({ id: "2", advancePaid: 200, settlements: [{ amount: 300 }] }), channelId: "d" },
    { ...market({ id: "3", costLines: [] }), channelId: "d" },
  ];
  const incidents = [{ kind: "UNSELLABLE_WRITE_OFF", lossAmount: 25, refundAmount: 0, courierFee: 0, orderCountsAsSale: null, channelId: null }];
  const r = aggregateChannelReport(orders, [{ amount: 70, channelId: "d" }, { amount: 30, channelId: null }], channels, incidents);
  const acct = S(orders.map(({ channelId: _c, ...x }) => x), { expenses: [{ category: "e", amount: 70 }, { category: "e", amount: 30 }], incidents });
  assert.equal(r.combined.revenue, acct.orderValue);
  assert.equal(r.combined.collected, acct.cashIn);
  assert.equal(r.combined.netProfitEstimate, acct.profit);
  assert.equal(r.combined.marketplaceReceivable, acct.marketplaceReceivable);
  assert.equal(r.channels[0].netProfitEstimate + r.channels[1].netProfitEstimate - 30 - 25, r.combined.netProfitEstimate); // unassigned expense and loss only in combined
  assert.equal(r.channels[1].profitIsComplete, false);                                  // order 3 has no commission entry
  assert.equal(r.channels[0].profitIsComplete, true);
});

test("dashboard chart series sums to the same order value as the card", () => {
  const orders = [o({ placedOn: "2026-10-01" }), o({ id: "b", placedOn: "2026-10-01", total: 500 }), o({ id: "c", placedOn: "2026-10-02", status: "CANCELLED" })];
  const series = orderValueByDay(orders);
  assert.deepEqual(series, [{ date: "2026-10-01", total: 1560 }]);
  assert.equal(series.reduce((a, d) => a + d.total, 0), S(orders).orderValue);
});

// ---- validation -------------------------------------------------------------------------------------------------------------------
test("transaction references normalise: case, spaces and dashes cannot hide a duplicate", () => {
  for (const same of ["8N7A6D5EE7", " 8n7a 6d5ee7 ", "8N7A-6D5EE7", "8n7a\u20136d5ee7"]) assert.deepEqual(normalizeTxnRef(same), { ok: true, value: "8N7A6D5EE7" });
  for (const bad of ["", "abc", "x".repeat(61), "TX<1>", 5, null]) assert.equal(normalizeTxnRef(bad as never).ok, false, String(bad));
});

test("settlement input is validated on the server: positive 2-decimal amount, real past date, bounded reference", () => {
  const ok = { orderId: "o1", amount: 100.25, receivedOn: "2026-10-05", reference: " pay 77 " };
  const v = validateSettlementInput(ok, new Date("2026-10-28T00:00:00Z"));
  assert.ok(v.ok && v.value.reference === "PAY77" && v.value.amount === 100.25);
  for (const bad of [{ amount: 0 }, { amount: -5 }, { amount: 1.005 }, { amount: NaN }, { amount: "5" }, { receivedOn: "2026-02-30" }, { receivedOn: "2026-12-31" }, { receivedOn: "" }, { reference: "ab" }, { orderId: "" }]) {
    assert.equal(validateSettlementInput({ ...ok, ...bad } as never, new Date("2026-10-28T00:00:00Z")).ok, false, JSON.stringify(bad));
  }
});

test("payment label: a partial advance is PARTIALLY_PAID, never PAID; only a full verified advance (or a marketplace prepayment) is PAID", () => {
  assert.equal(externalPaymentStatus("OTHER", 1000, 300, "PAID"), "PARTIALLY_PAID");
  assert.equal(externalPaymentStatus("MARKETPLACE", 1000, 300, "PAID"), "PARTIALLY_PAID");
  assert.equal(externalPaymentStatus("OTHER", 1000, 1000, "UNPAID"), "PAID");
  assert.equal(externalPaymentStatus("OTHER", 1000, 0, "PAID"), "UNPAID");        // an unverifiable "paid" claim on a non-marketplace channel
  assert.equal(externalPaymentStatus("MARKETPLACE", 1000, 0, "PAID"), "PAID");
  assert.equal(externalPaymentStatus("MARKETPLACE", 1000, 0, "UNPAID"), "UNPAID");
});

const good = () => ({ channelId: "c", externalOrderRef: "D-1001", customer: { fullName: "Jo", phone: "01711000000", line1: "House 1" }, items: [{ productId: "p", quantity: 1, unitPrice: 1000 }], shippingTotal: 60, costLines: [{ kind: "MARKETPLACE_COMMISSION", amount: 100 }] });
test("external order input: advance reference normalised; payout needs amount + date and never exceeds the expected payout; a bare SETTLED flag is refused", () => {
  const adv = parseExternalOrderInput({ ...good(), advanceReceived: 200, advanceMethod: "BKASH", advanceReference: " 8n7a-6d5ee7 " });
  assert.ok(adv.ok && adv.value.advanceReference === "8N7A6D5EE7");
  assert.equal(parseExternalOrderInput({ ...good(), advanceReceived: 200, advanceMethod: "BKASH", advanceReference: "" }).ok, false);
  assert.equal(parseExternalOrderInput({ ...good(), advanceReceived: 0, advanceReference: "ABCD1234" }).ok, false);          // reference without an amount
  assert.equal(parseExternalOrderInput({ ...good(), advanceReceived: 2000 }).ok, false);                                  // advance above the order total
  const bare = parseExternalOrderInput({ ...good(), settlementStatus: "SETTLED" });
  assert.ok(!bare.ok && /without an amount|actually arrived/.test(bare.message));
  assert.equal(parseExternalOrderInput({ ...good(), settlementReceived: 400 }).ok, false);                                 // no date
  assert.ok(parseExternalOrderInput({ ...good(), settlementReceived: 400, settlementReceivedOn: "2026-10-05" }).ok);
  const over = parseExternalOrderInput({ ...good(), settlementReceived: 961, settlementReceivedOn: "2026-10-05" });       // expected = 1060 − 100 = 960
  assert.ok(!over.ok && /more than the expected payout/.test(over.message));
  const afterAdvance = parseExternalOrderInput({ ...good(), advanceReceived: 300, advanceMethod: "COD", settlementReceived: 700, settlementReceivedOn: "2026-10-05" }); // expected 660
  assert.equal(afterAdvance.ok, false);
});
