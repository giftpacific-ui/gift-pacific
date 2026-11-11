/**
 * ONE set of financial definitions for the Accounts page, the dashboard finance cards, the channel report, the sales report
 * and every CSV export. Pure and unit-tested. See HANDOFF_GIFTPACIFIC.md §14 and Appendix C for the same text with worked examples.
 *
 * All money is summed in WHOLE PAISA (integers) so totals never drift; Decimal(10,2) values arrive as numbers at the edge.
 *
 * DATE BASIS (identical for every figure): an order belongs to the day it was PLACED (the marketplace "placed" date for
 * third-party orders, otherwise when it was recorded). Expenses use their spent date, incidents their occurred date,
 * procurement receipts their receipt date. COD collections and marketplace payouts are attributed to the day of the ORDER
 * they belong to ("money from the orders of this period"), NOT to the day the cash arrived — so this is a cohort view, not a
 * bank statement. (Each payout's own received date is stored and shown per order.)
 *
 * THE ELEVEN CONCEPTS — never mixed, each with exactly one rule:
 *  1  Order sales / revenue        orders that still count as business (all except Cancelled / Refunded / Failed delivery):
 *                                  items subtotal − discounts = net sales (goods). Delivery billed is income, tax is pass-through.
 *  2  Verified money collected     verified advances (Order.advancePaid) + COD of DELIVERED non-marketplace orders (total − advance)
 *                                  + marketplace payouts actually RECORDED as received. `paymentStatus` is a label and is NEVER cash.
 *  3  Unverified payment claims    PENDING advance payments (a customer typed a transaction id; nobody has checked the wallet).
 *                                  Shown on their own, never added to cash, never reduce the customer balance.
 *  4  Outstanding customer balance sale orders not yet delivered, not marketplace: total − verified advance.
 *  5  Marketplace receivable       expected payout (total − advance − fees the marketplace withholds) − payouts received. Cash only when recorded.
 *  6  Product / combination cost   COGS = quantity × the order line's immutable unit-cost snapshot (combos: sum of components). Unknown ≠ 0.
 *  7  Courier & delivery expenses  COURIER_FEE order costs + courier return/extra fees from incidents. Delivery CHARGES billed to the
 *                                  customer are income (concept 1) and are never netted against these costs.
 *  8  Commission & other costs     per-order cost lines. Commission / payment fee on a MARKETPLACE order are WITHHELD from the payout
 *                                  (profit cost, not a second cash outgoing); every other cost line is cash we pay.
 *  9  Procurement cash outflow     goods-received purchase cost. CASH only: the same goods are costed through COGS, so purchases NEVER
 *                                  reduce profit (that would count the inventory twice).
 * 10  Returns / refunds / damage   incidents: loss (goods gone) reduces profit; refund on a still-counted sale = compensation (reduces
 *                                  profit); refund on an excluded order only moves cash; restocked goods are never a loss.
 * 11  Estimated vs complete profit profit is COMPLETE only when every sold line has a unit-cost snapshot AND every sold marketplace order
 *                                  has a commission entry (enter 0 if there is none). Otherwise it is labelled ESTIMATED with the reasons.
 *
 * Sales/profit are ACCRUAL (what was sold); cash is separate (what actually arrived / left). Per-order `orderFacts()` is the only place
 * a rule lives; `buildFinancialSummary` and every report just add those facts up.
 */
import { fromPaisa, toPaisa } from "@/lib/money";
import { expectedPayoutPaisa, feesWithheldPaisa, settlementState, WITHHELD_COST_KINDS, type SettlementState } from "@/lib/settlement";

export const NON_SALE_STATUSES = ["CANCELLED", "REFUNDED", "FAILED_DELIVERY"] as const;
export { WITHHELD_COST_KINDS };

export type AcctOrder = {
  id: string;
  status: string;
  channelKind: "WEBSITE" | "MARKETPLACE" | "OTHER";
  paymentMethod: string;
  fulfillmentMode: string;
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  total: number;
  /** VERIFIED advance/part-payments received before delivery (never a customer's claim). */
  advancePaid: number;
  /** Legacy cached label. Ignored for money: the payout state is derived from `settlements` and the expected payout. */
  settlementStatus?: string;
  /** A label only. NEVER used to decide whether cash was received. */
  paymentStatus: string;
  items: { quantity: number; lineTotal: number; unitCost: number | null }[];
  /** Cost lines actually incurred for this order (any status: a courier fee on a failed delivery is still a cost). */
  costLines: { kind: string; amount: number }[];
  /** Advance payments somebody CLAIMED but nobody verified yet. */
  pendingClaims?: number[];
  /** Marketplace payouts actually recorded as received (amount is what arrived, not what was expected). */
  settlements?: { amount: number; receivedOn?: string | null; legacyAssumed?: boolean }[];
  // ---- descriptive (reports / CSV only; never change a figure)
  orderNumber?: string;
  channelId?: string;
  channelName?: string;
  externalOrderRef?: string | null;
  /** Dhaka day (YYYY-MM-DD) the order is dated to. */
  placedOn?: string;
};
export type AcctExpense = { category: string; amount: number; channelId?: string | null };
export type AcctIncident = { kind: string; lossAmount: number; refundAmount: number; courierFee: number; orderCountsAsSale: boolean | null; channelId?: string | null };
export type AcctReceipt = { totalCost: number | null };

/** What one order contributes. All amounts are WHOLE PAISA. */
export type OrderFacts = {
  isSale: boolean;
  isMarketplace: boolean;
  gross: number; discounts: number; netSales: number; delivery: number; tax: number; orderValue: number;
  cogs: number; cogsUnknownLines: number;
  costsByKind: Record<string, number>; costsTotal: number;
  /** Part of costsTotal the marketplace deducts from the payout (not a separate cash outgoing). */
  feesWithheld: number;
  cashCosts: number;
  advance: number;
  codCollected: number; codOutstanding: number;
  expectedPayout: number; payoutReceived: number; receivable: number; overReceived: number; legacyAssumedReceived: number;
  settlement: SettlementState | null;
  unverifiedClaims: number; claimCount: number;
  commissionMissing: boolean;
  /** Net sales + delivery − COGS (sales only) − all order costs (any status). Sums to the summary's order margin. */
  margin: number;
  marginIsComplete: boolean;
};

export function orderFacts(o: AcctOrder): OrderFacts {
  const isSale = !(NON_SALE_STATUSES as readonly string[]).includes(o.status);
  const isMarketplace = o.channelKind === "MARKETPLACE";
  const advance = toPaisa(o.advancePaid);
  const total = toPaisa(o.total);

  const costsByKind: Record<string, number> = {};
  let costsTotal = 0;
  for (const c of o.costLines) { const a = toPaisa(c.amount); costsByKind[c.kind] = (costsByKind[c.kind] ?? 0) + a; costsTotal += a; }
  const feesWithheld = isMarketplace ? feesWithheldPaisa(o.costLines) : 0;

  let gross = 0, discounts = 0, delivery = 0, tax = 0, orderValue = 0, cogs = 0, unknown = 0;
  if (isSale) {
    gross = toPaisa(o.subtotal); discounts = toPaisa(o.discountTotal); delivery = toPaisa(o.shippingTotal); tax = toPaisa(o.taxTotal); orderValue = total;
    for (const i of o.items) { if (i.unitCost === null) unknown++; else cogs += Math.round(i.quantity * toPaisa(i.unitCost)); }
  }

  let codCollected = 0, codOutstanding = 0;
  if (isSale && !isMarketplace) {
    const balance = Math.max(total - advance, 0);
    if (o.status === "DELIVERED") codCollected = balance; else codOutstanding = balance;
  }

  const received = (o.settlements ?? []).reduce((s, x) => s + toPaisa(x.amount), 0);
  const legacy = (o.settlements ?? []).reduce((s, x) => (x.legacyAssumed ? s + toPaisa(x.amount) : s), 0);
  const expected = isMarketplace ? expectedPayoutPaisa({ total: o.total, advancePaid: o.advancePaid, costLines: o.costLines }) : 0;
  const receivable = isMarketplace && isSale ? Math.max(expected - received, 0) : 0;
  const overReceived = isMarketplace && isSale ? Math.max(received - expected, 0) : 0;
  const settlement = isMarketplace && isSale ? settlementState(expected, received) : null;

  const claims = isSale ? (o.pendingClaims ?? []).filter((c) => c > 0) : [];
  const commissionMissing = isMarketplace && isSale && !o.costLines.some((c) => c.kind === "MARKETPLACE_COMMISSION");

  const netSales = gross - discounts;
  const margin = (isSale ? netSales + delivery - cogs : 0) - costsTotal;
  return {
    isSale, isMarketplace, gross, discounts, netSales, delivery, tax, orderValue, cogs, cogsUnknownLines: unknown,
    costsByKind, costsTotal, feesWithheld, cashCosts: costsTotal - feesWithheld,
    advance, codCollected, codOutstanding,
    expectedPayout: expected, payoutReceived: received, receivable, overReceived, legacyAssumedReceived: legacy, settlement,
    unverifiedClaims: claims.reduce((s, c) => s + toPaisa(c), 0), claimCount: claims.length,
    commissionMissing, margin, marginIsComplete: unknown === 0 && !commissionMissing,
  };
}

export type FinancialSummary = {
  // ---- 1 sales (accrual)
  ordersPlaced: number;
  saleOrders: number;
  excludedOrders: number;
  grossSales: number;       // items subtotal of sale orders
  discounts: number;
  netSales: number;         // gross - discounts (goods only)
  deliveryBilled: number;   // delivery charge actually billed to customers (after rewards) — INCOME
  taxCollected: number;     // pass-through, excluded from profit
  orderValue: number;       // what customers were billed (netSales + delivery + tax)
  // ---- 6/7/8/10 costs
  cogs: number;             // from unit-cost snapshots (known lines only)
  cogsUnknownLines: number; // lines without a snapshot — profit is INCOMPLETE when > 0
  orderCosts: Record<string, number>; // by cost-line kind (commission, payment fee, courier, packaging, other)
  orderCostsTotal: number;
  courierOrderCosts: number;      // COURIER_FEE order costs (delivery EXPENSE)
  marketplaceFeesWithheld: number; // commission + payment fee the marketplace deducts from payouts (subset of orderCostsTotal)
  incidentLosses: number;   // damaged / written-off goods and boxes
  incidentCourierFees: number;
  compensation: number;     // refunds/compensation on orders that still count as sales (reduce sales performance)
  operatingExpenses: number;
  expensesByCategory: Record<string, number>;
  // ---- 11 profit
  orderMargin: number;      // net sales + delivery − COGS − ALL order costs (what the per-order CSV rows add up to)
  grossProfit: number;      // netSales - cogs
  profit: number;           // grossProfit + delivery - orderCosts - losses - courier fees - compensation - operating expenses
  profitIsComplete: boolean;
  profitIncompleteReasons: string[];
  commissionMissingOrders: number; // sold marketplace orders with no commission entry (enter 0 when there is none)
  // ---- 2 cash (money actually received/paid for these orders and records)
  advancesReceived: number;
  codCollected: number;     // delivered non-marketplace orders: total - advance
  marketplaceSettled: number; // marketplace payouts actually RECORDED as received (not assumed)
  cashIn: number;
  refundsPaid: number;
  procurementPurchases: number;
  cashOut: number;          // refunds + expenses + order costs paid by us (NOT the fees a marketplace withholds) + incident courier fees + procurement purchases
  netCash: number;
  // ---- 3 unverified claims (NOT cash)
  unverifiedClaims: number;
  unverifiedClaimCount: number;
  // ---- 4/5 receivables / outstanding
  codOutstanding: number;   // non-marketplace sale orders not yet delivered: total - verified advance
  marketplaceExpectedPayout: number; // sale marketplace orders: total − advance − fees withheld
  marketplaceReceivable: number;     // expected − received (never negative)
  marketplacePartialOrders: number;  // some, but not all, of the expected payout has arrived
  marketplaceOverReceived: number;   // received more than currently expected (a cost line was probably corrected downwards)
  marketplaceLegacyAssumed: number;  // received amounts back-filled from an old SETTLED flag (assumed full — verify)
  // ---- disclosure
  refundedOrdersWithoutRefundRecord: number;
};

export function buildFinancialSummary(input: {
  orders: readonly AcctOrder[];
  expenses: readonly AcctExpense[];
  incidents: readonly AcctIncident[];
  receipts: readonly AcctReceipt[];
}): FinancialSummary {
  let gross = 0, disc = 0, delivery = 0, tax = 0, orderValue = 0, cogs = 0, unknown = 0, orderCostsTotal = 0, cashCosts = 0, withheld = 0, courierCosts = 0;
  let advances = 0, cod = 0, settled = 0, codOut = 0, receivable = 0, expectedPayout = 0, over = 0, legacy = 0, partial = 0;
  let claims = 0, claimCount = 0, commissionMissing = 0, margin = 0;
  let sale = 0, excluded = 0;
  const costs: Record<string, number> = {};

  for (const o of input.orders) {
    const f = orderFacts(o);
    for (const [k, v] of Object.entries(f.costsByKind)) costs[k] = (costs[k] ?? 0) + v;
    courierCosts += f.costsByKind.COURIER_FEE ?? 0;
    orderCostsTotal += f.costsTotal; cashCosts += f.cashCosts; withheld += f.feesWithheld; margin += f.margin;
    // A verified advance is real money even if the order is later cancelled (until it is refunded via a refund incident).
    advances += f.advance;
    // Payouts the marketplace really sent are cash whatever happened to the order afterwards.
    settled += f.payoutReceived; legacy += f.legacyAssumedReceived;
    if (!f.isSale) { excluded++; continue; }
    sale++;
    gross += f.gross; disc += f.discounts; delivery += f.delivery; tax += f.tax; orderValue += f.orderValue; cogs += f.cogs; unknown += f.cogsUnknownLines;
    cod += f.codCollected; codOut += f.codOutstanding;
    receivable += f.receivable; expectedPayout += f.expectedPayout; over += f.overReceived;
    if (f.settlement === "PARTIAL") partial++;
    claims += f.unverifiedClaims; claimCount += f.claimCount;
    if (f.commissionMissing) commissionMissing++;
  }

  let losses = 0, courierFees = 0, compensation = 0, refunds = 0;
  for (const x of input.incidents) {
    losses += toPaisa(x.lossAmount);
    courierFees += toPaisa(x.courierFee);
    refunds += toPaisa(x.refundAmount);
    // Refund on an order that still counts as a sale = compensation (reduces profit). Refund on a Cancelled/Refunded/Failed order
    // only moves cash, because that order's revenue was already excluded — counting it again would double-count.
    if (x.orderCountsAsSale === true) compensation += toPaisa(x.refundAmount);
  }

  const expensesByCategory: Record<string, number> = {};
  let opex = 0;
  for (const e of input.expenses) { const a = toPaisa(e.amount); opex += a; expensesByCategory[e.category] = (expensesByCategory[e.category] ?? 0) + a; }
  const purchases = input.receipts.reduce((s, r) => s + (r.totalCost === null ? 0 : toPaisa(r.totalCost)), 0);

  const netSales = gross - disc;
  const grossProfit = netSales - cogs;
  const profit = grossProfit + delivery - orderCostsTotal - losses - courierFees - compensation - opex;
  const cashIn = advances + cod + settled;
  // Fees the marketplace withholds were already taken out of the payout: counting them again here would double-count.
  const cashOut = refunds + opex + cashCosts + courierFees + purchases;

  const reasons: string[] = [];
  if (unknown > 0) reasons.push(`${unknown} sold order line${unknown === 1 ? " has" : "s have"} no unit cost recorded`);
  if (commissionMissing > 0) reasons.push(`${commissionMissing} sold marketplace order${commissionMissing === 1 ? " has" : "s have"} no commission entry (enter 0 if none)`);

  const mapOut = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fromPaisa(v)]));
  return {
    ordersPlaced: input.orders.length, saleOrders: sale, excludedOrders: excluded,
    grossSales: fromPaisa(gross), discounts: fromPaisa(disc), netSales: fromPaisa(netSales), deliveryBilled: fromPaisa(delivery), taxCollected: fromPaisa(tax), orderValue: fromPaisa(orderValue),
    cogs: fromPaisa(cogs), cogsUnknownLines: unknown, orderCosts: mapOut(costs), orderCostsTotal: fromPaisa(orderCostsTotal), courierOrderCosts: fromPaisa(courierCosts), marketplaceFeesWithheld: fromPaisa(withheld),
    incidentLosses: fromPaisa(losses), incidentCourierFees: fromPaisa(courierFees), compensation: fromPaisa(compensation),
    operatingExpenses: fromPaisa(opex), expensesByCategory: mapOut(expensesByCategory),
    orderMargin: fromPaisa(margin), grossProfit: fromPaisa(grossProfit), profit: fromPaisa(profit), profitIsComplete: reasons.length === 0, profitIncompleteReasons: reasons, commissionMissingOrders: commissionMissing,
    advancesReceived: fromPaisa(advances), codCollected: fromPaisa(cod), marketplaceSettled: fromPaisa(settled), cashIn: fromPaisa(cashIn),
    refundsPaid: fromPaisa(refunds), procurementPurchases: fromPaisa(purchases), cashOut: fromPaisa(cashOut), netCash: fromPaisa(cashIn - cashOut),
    unverifiedClaims: fromPaisa(claims), unverifiedClaimCount: claimCount,
    codOutstanding: fromPaisa(codOut), marketplaceExpectedPayout: fromPaisa(expectedPayout), marketplaceReceivable: fromPaisa(receivable), marketplacePartialOrders: partial, marketplaceOverReceived: fromPaisa(over), marketplaceLegacyAssumed: fromPaisa(legacy),
    refundedOrdersWithoutRefundRecord: 0,
  };
}

/** Sale-order value (what customers were billed) per Dhaka day: the dashboard chart. Same orders + same rule as `orderValue`. */
export function orderValueByDay(orders: readonly AcctOrder[]): { date: string; total: number }[] {
  const byDay = new Map<string, number>();
  for (const o of orders) {
    const f = orderFacts(o);
    if (!f.isSale || !o.placedOn) continue;
    byDay.set(o.placedOn, (byDay.get(o.placedOn) ?? 0) + f.orderValue);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, total]) => ({ date, total: fromPaisa(total) }));
}

/** The definitions shown on the Accounts page (same wording as the header comment and HANDOFF_GIFTPACIFIC.md §14). */
export const FINANCIAL_DEFINITIONS: { term: string; rule: string }[] = [
  { term: "Order sales", rule: "Orders that still count: everything except Cancelled, Refunded and Failed delivery. Net sales = items − discounts. Delivery billed is income; tax is pass-through." },
  { term: "Verified money collected", rule: "Verified advances + COD of delivered orders (total − advance) + marketplace payouts actually recorded as received. A payment-status label is never cash." },
  { term: "Unverified payment claims", rule: "Customer-typed transaction ids that nobody has checked. Shown separately; never counted as cash and never reduce the balance owed." },
  { term: "Outstanding customer balance", rule: "Not-yet-delivered, non-marketplace sale orders: total − verified advance." },
  { term: "Marketplace receivable", rule: "Expected payout (total − advance paid to us − commission/payment fee the marketplace withholds) − payouts recorded as received. A payout is cash only once recorded; a partial payout leaves the rest receivable." },
  { term: "Product / combination cost", rule: "Quantity × the unit-cost snapshot saved on the order line (combos: sum of components). An unknown cost is never treated as 0." },
  { term: "Courier & delivery expenses", rule: "Courier fee order costs + return/extra courier fees. Delivery charges billed to customers are income and are never netted against them." },
  { term: "Commission & other order costs", rule: "Recorded per order. Commission and payment fee on a marketplace order are withheld from the payout (profit cost, not a second cash outgoing); other costs are cash we pay." },
  { term: "Procurement cash outflow", rule: "Goods-received purchase cost. Cash only — the goods are costed through cost of goods sold, so purchases never reduce profit." },
  { term: "Returns, refunds, damage, write-offs", rule: "Losses reduce profit. A refund on a still-counted sale is compensation (reduces profit); on an excluded order it only moves cash. Restocked goods are not a loss." },
  { term: "Estimated vs complete profit", rule: "Complete only when every sold line has a unit cost and every sold marketplace order has a commission entry. Otherwise the figure is labelled Estimated and the gaps are listed." },
];

/** One CSV cell. Numbers are written as-is (a negative profit stays `-130`); TEXT starting with = + - @ is neutralised so a spreadsheet never evaluates it. */
const esc = (v: string | number) => {
  const t = String(v);
  const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Stable CSV of the summary so the export always equals what the page shows. */
export function summaryToCsv(s: FinancialSummary, range: { from: string; to: string }): string {
  const rows: [string, string | number][] = [
    ["Period", `${range.from} to ${range.to}`],
    ["Orders placed", s.ordersPlaced], ["Orders counted as sales", s.saleOrders], ["Cancelled/refunded/failed (excluded)", s.excludedOrders],
    ["Gross sales (goods)", s.grossSales], ["Discounts", s.discounts], ["Net sales (goods)", s.netSales], ["Delivery charges billed", s.deliveryBilled], ["Tax collected (excluded from profit)", s.taxCollected], ["Order value billed", s.orderValue],
    ["Cost of goods sold", s.cogs], ["Order lines without a cost snapshot", s.cogsUnknownLines],
    ...Object.entries(s.orderCosts).map(([k, v]) => [`Order cost: ${k}`, v] as [string, number]),
    ["Order costs total", s.orderCostsTotal], ["of which courier fees (delivery expense)", s.courierOrderCosts], ["of which marketplace fees withheld from payouts", s.marketplaceFeesWithheld],
    ["Damage/write-off losses", s.incidentLosses], ["Courier return/extra fees", s.incidentCourierFees], ["Refund compensation on sales", s.compensation],
    ["Operating expenses", s.operatingExpenses], ...Object.entries(s.expensesByCategory).map(([k, v]) => [`Expense: ${k}`, v] as [string, number]),
    ["Order margin (net sales + delivery - COGS - all order costs)", s.orderMargin],
    ["Gross profit (net sales - COGS)", s.grossProfit], [s.profitIsComplete ? "Profit" : "Estimated profit (some costs unknown)", s.profit],
    ["Profit status", s.profitIsComplete ? "Complete" : `Incomplete: ${s.profitIncompleteReasons.join("; ")}`],
    ["Sold marketplace orders without a commission entry", s.commissionMissingOrders],
    ["Advances received (verified)", s.advancesReceived], ["COD collected (delivered)", s.codCollected], ["Marketplace payouts received (actual)", s.marketplaceSettled], ["Cash in", s.cashIn],
    ["Refunds paid", s.refundsPaid], ["Procurement purchases", s.procurementPurchases], ["Cash out", s.cashOut], ["Net cash movement", s.netCash],
    ["Unverified payment claims (NOT cash)", s.unverifiedClaims], ["Unverified claim count", s.unverifiedClaimCount],
    ["COD outstanding (in pipeline)", s.codOutstanding],
    ["Marketplace expected payout (after fees withheld)", s.marketplaceExpectedPayout], ["Marketplace receivable remaining", s.marketplaceReceivable], ["Marketplace orders partly paid", s.marketplacePartialOrders],
    ["Marketplace received above expected", s.marketplaceOverReceived], ["Marketplace received amounts assumed from an old flag", s.marketplaceLegacyAssumed],
  ];
  return ["Metric,Value", ...rows.map(([k, v]) => `${esc(k)},${esc(v)}`)].join("\r\n") + "\r\n";
}

/**
 * Per-order financial CSV built from the SAME `orderFacts()` the summary uses. The final TOTAL row therefore equals the
 * summary figures (order value, advances, COD, payouts, receivable, margin…) for the same orders.
 */
export const ORDER_CSV_HEADER = [
  "Order number", "Channel", "External ref", "Placed on", "Status", "Counted as sale", "Order value billed", "Verified advance", "Unverified claim (not cash)",
  "COD collected", "Customer balance outstanding", "Marketplace fees withheld", "Expected payout", "Payout received", "Receivable remaining", "Settlement", "Payout dates",
  "Cost of goods sold", "Lines without cost", "All order costs", "Order margin", "Margin complete",
] as const;

export function ordersFinancialCsv(orders: readonly AcctOrder[]): string {
  const money = (p: number) => fromPaisa(p);
  let tot = { value: 0, adv: 0, claim: 0, cod: 0, out: 0, fees: 0, exp: 0, rec: 0, recv: 0, cogs: 0, unk: 0, costs: 0, margin: 0 };
  const lines = orders.map((o) => {
    const f = orderFacts(o);
    tot = { value: tot.value + f.orderValue, adv: tot.adv + f.advance, claim: tot.claim + f.unverifiedClaims, cod: tot.cod + f.codCollected, out: tot.out + f.codOutstanding, fees: tot.fees + f.feesWithheld,
      exp: tot.exp + (f.isSale ? f.expectedPayout : 0), rec: tot.rec + f.payoutReceived, recv: tot.recv + f.receivable, cogs: tot.cogs + f.cogs, unk: tot.unk + f.cogsUnknownLines, costs: tot.costs + f.costsTotal, margin: tot.margin + f.margin };
    const dates = (o.settlements ?? []).map((s) => s.receivedOn ?? "").filter(Boolean).join(" | ");
    return [o.orderNumber ?? o.id, o.channelName ?? o.channelKind, o.externalOrderRef ?? "", o.placedOn ?? "", o.status, f.isSale ? "yes" : "no", money(f.orderValue), money(f.advance), money(f.unverifiedClaims),
      money(f.codCollected), money(f.codOutstanding), money(f.feesWithheld), money(f.isSale ? f.expectedPayout : 0), money(f.payoutReceived), money(f.receivable), f.settlement ?? (f.isMarketplace ? "NOT_COUNTED" : "NOT_APPLICABLE"), dates,
      money(f.cogs), f.cogsUnknownLines, money(f.costsTotal), money(f.margin), f.marginIsComplete ? "yes" : "no"];
  });
  const total = ["TOTAL", "", "", "", "", "", money(tot.value), money(tot.adv), money(tot.claim), money(tot.cod), money(tot.out), money(tot.fees), money(tot.exp), money(tot.rec), money(tot.recv), "", "", money(tot.cogs), tot.unk, money(tot.costs), money(tot.margin), ""];
  return [ORDER_CSV_HEADER as readonly string[], ...lines, total].map((r) => r.map((c) => esc(c as string | number)).join(",")).join("\r\n") + "\r\n";
}
