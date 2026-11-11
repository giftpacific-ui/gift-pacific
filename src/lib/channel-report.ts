/**
 * Channel-aware report. Pure. It adds NO definitions of its own: every figure comes from `buildFinancialSummary` in
 * src/lib/accounting.ts (the same one the Accounts page, dashboard and CSVs use), applied to one channel's orders, expenses
 * and incidents at a time. With no filters, "Combined" therefore equals the Accounts page for the same dates.
 *
 *  - Revenue            = order value billed for SALE orders (not cash, not profit).
 *  - Collected          = VERIFIED money for those orders: verified advances + COD of delivered orders + marketplace payouts actually recorded.
 *  - Product cost       = known unit costs only; profit is flagged INCOMPLETE when any are unknown or a sold marketplace order has no commission entry.
 *  - Profit             = net sales + delivery − product cost − order costs − losses/return fees/compensation (− expenses for the net figure).
 */
import { buildFinancialSummary, NON_SALE_STATUSES, type AcctIncident, type AcctOrder, type FinancialSummary } from "@/lib/accounting";
import { fromPaisa, toPaisa } from "@/lib/money";

export const NON_SALE = NON_SALE_STATUSES;

export type ReportChannel = { id: string; name: string; kind: "WEBSITE" | "MARKETPLACE" | "OTHER" };
/** An order row for the report: the Accounting order minus the channel kind (taken from the channel list). */
export type ReportOrderRow = Omit<AcctOrder, "id" | "channelKind" | "paymentMethod" | "fulfillmentMode" | "taxTotal" | "advancePaid"> &
  Partial<Pick<AcctOrder, "id" | "paymentMethod" | "fulfillmentMode" | "taxTotal" | "advancePaid">> & { channelId: string };
export type ReportExpense = { amount: number; channelId: string | null };
export type ReportIncident = AcctIncident;

export type ChannelSummary = {
  channelId: string | null;
  name: string;
  kind: ReportChannel["kind"] | "ALL";
  orders: number;
  unitsSold: number;
  grossSales: number;
  discounts: number;
  shippingCharged: number;
  revenue: number;
  /** Verified money received for these orders (never a payment-status label). */
  collected: number;
  cancelledOrReturned: number;
  productCost: number;
  itemsWithCost: number;
  itemsTotal: number;
  /** Share (0–1) of sold items whose cost is known. */
  costCoverage: number;
  commissionRecorded: number;
  ordersWithCommission: number;
  otherRecordedCosts: number;
  courierFees: number;
  /** Losses, return fees and refund compensation attributed to this channel's orders. */
  incidentCosts: number;
  expenses: number;
  profitEstimateBeforeExpenses: number;
  netProfitEstimate: number;
  profitIsComplete: boolean;
  profitIncompleteReasons: string[];
  unverifiedClaims: number;
  marketplaceReceivable: number;
  /** The full shared summary this row was derived from. */
  summary: FinancialSummary;
};

const toAcct = (o: ReportOrderRow, kind: ReportChannel["kind"]): AcctOrder => ({
  id: o.id ?? "", paymentMethod: o.paymentMethod ?? "", fulfillmentMode: o.fulfillmentMode ?? "", taxTotal: o.taxTotal ?? 0, advancePaid: o.advancePaid ?? 0, ...o, channelKind: kind,
});

function finish(
  orders: readonly AcctOrder[], expenses: readonly { amount: number; channelId: string | null }[], incidents: readonly AcctIncident[],
  base: Pick<ChannelSummary, "channelId" | "name" | "kind">,
): ChannelSummary {
  const s = buildFinancialSummary({ orders, expenses: expenses.map((e) => ({ category: "expense", amount: e.amount })), incidents, receipts: [] });
  let units = 0, itemsWithCost = 0, itemsTotal = 0, withCommission = 0;
  for (const o of orders) {
    if ((NON_SALE as readonly string[]).includes(o.status)) continue;
    for (const i of o.items) { units += i.quantity; itemsTotal += i.quantity; if (i.unitCost !== null) itemsWithCost += i.quantity; }
    if (o.costLines.some((c) => c.kind === "MARKETPLACE_COMMISSION")) withCommission++;
  }
  const commission = s.orderCosts.MARKETPLACE_COMMISSION ?? 0;
  const courier = s.orderCosts.COURIER_FEE ?? 0;
  const incidentCosts = s.incidentLosses + s.incidentCourierFees + s.compensation;
  const before = fromPaisa(toPaisa(s.profit) + toPaisa(s.operatingExpenses));
  return {
    ...base, orders: s.saleOrders, unitsSold: units, grossSales: s.grossSales, discounts: s.discounts, shippingCharged: s.deliveryBilled, revenue: s.orderValue,
    collected: s.cashIn, cancelledOrReturned: s.excludedOrders, productCost: s.cogs, itemsWithCost, itemsTotal, costCoverage: itemsTotal === 0 ? 0 : itemsWithCost / itemsTotal,
    commissionRecorded: commission, ordersWithCommission: withCommission, otherRecordedCosts: fromPaisa(toPaisa(s.orderCostsTotal) - toPaisa(commission) - toPaisa(courier)), courierFees: courier,
    incidentCosts, expenses: s.operatingExpenses, profitEstimateBeforeExpenses: before, netProfitEstimate: s.profit,
    profitIsComplete: s.profitIsComplete, profitIncompleteReasons: s.profitIncompleteReasons, unverifiedClaims: s.unverifiedClaims, marketplaceReceivable: s.marketplaceReceivable, summary: s,
  };
}

export function aggregateChannelReport(
  orders: readonly ReportOrderRow[],
  expenses: readonly ReportExpense[],
  channels: readonly ReportChannel[],
  incidents: readonly ReportIncident[] = [],
): { channels: ChannelSummary[]; combined: ChannelSummary; unassignedExpenses: number; unassignedIncidentCosts: number } {
  const kindOf = new Map(channels.map((c) => [c.id, c.kind]));
  const inScope = orders.filter((o) => kindOf.has(o.channelId)).map((o) => toAcct(o, kindOf.get(o.channelId)!)); // orders of a channel the caller did not ask about are ignored
  const byChannel = new Map<string, AcctOrder[]>(channels.map((c) => [c.id, []]));
  for (const o of inScope) byChannel.get(o.channelId!)!.push(o);

  let unassignedExp = 0;
  for (const e of expenses) if (!e.channelId || !kindOf.has(e.channelId)) unassignedExp += toPaisa(e.amount);
  const scopedIncidents = incidents.filter((x) => x.channelId == null || kindOf.has(x.channelId));
  const unassignedInc = scopedIncidents.filter((x) => x.channelId == null);

  return {
    channels: channels.map((c) => finish(
      byChannel.get(c.id)!, expenses.filter((e) => e.channelId === c.id), scopedIncidents.filter((x) => x.channelId === c.id),
      { channelId: c.id, name: c.name, kind: c.kind },
    )),
    combined: finish(inScope, expenses, scopedIncidents, { channelId: null, name: "Combined", kind: "ALL" }),
    unassignedExpenses: fromPaisa(unassignedExp),
    unassignedIncidentCosts: fromPaisa(unassignedInc.reduce((s, x) => s + toPaisa(x.lossAmount) + toPaisa(x.courierFee), 0)),
  };
}
