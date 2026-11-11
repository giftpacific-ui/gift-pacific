import "server-only";
import { prisma } from "@/lib/db/prisma";
import { buildFinancialSummary, NON_SALE_STATUSES, type AcctExpense, type AcctIncident, type AcctOrder, type AcctReceipt, type FinancialSummary } from "@/lib/accounting";
import { MAX_REPORT_ORDERS, parseReportRange, type ReportRange } from "@/lib/report";

export type AccountingInputs = {
  range: ReportRange;
  orders: AcctOrder[];
  expenses: AcctExpense[];
  incidents: AcctIncident[];
  receipts: AcctReceipt[];
  truncated: boolean;
  /** Refunded orders (in the period) that have no REFUND incident: their cash-out is understated. */
  refundedOrdersWithoutRefundRecord: number;
};
export type AccountingResult = { range: ReportRange; summary: FinancialSummary; orders: AcctOrder[]; truncated: boolean; refundedOrdersWithoutRefundRecord: number };

const DHAKA_OFFSET_MS = 6 * 3600 * 1000;
const dhakaDay = (d: Date) => new Date(d.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
const isoDay = (d: Date | string) => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

/** THE order-date rule for every financial report: the marketplace "placed" date, else when the order was recorded. */
export function orderDateWhere(range: Pick<ReportRange, "start" | "end">) {
  return { OR: [{ externalPlacedAt: { gte: range.start, lte: range.end } }, { externalPlacedAt: null, createdAt: { gte: range.start, lte: range.end } }] };
}

/**
 * Loads and maps everything the financial definitions need, ONCE, for a Dhaka-day range. Used by the Accounts page, its CSVs,
 * the dashboard finance cards, the channel report and the sales report — so they cannot disagree about which orders count.
 * `channelId` / `status` narrow the scope (channel report filters); with neither, the result is the whole business.
 */
export async function loadAccountingInputs(params: { from?: string; to?: string; channelId?: string; status?: string }): Promise<AccountingInputs> {
  const range = parseReportRange(params.from, params.to);
  const dateFrom = new Date(`${range.from}T00:00:00.000Z`);
  const dateTo = new Date(`${range.to}T00:00:00.000Z`);

  const [orderRows, expenseRows, incidentRows, receiptRows] = await Promise.all([
    prisma.order.findMany({
      where: { ...orderDateWhere(range), ...(params.channelId ? { channelId: params.channelId } : {}), ...(params.status ? { status: params.status as "PENDING" } : {}) },
      orderBy: { createdAt: "desc" },
      take: MAX_REPORT_ORDERS + 1,
      select: {
        id: true, orderNumber: true, status: true, paymentMethod: true, paymentStatus: true, fulfillmentMode: true, subtotal: true, discountTotal: true, shippingTotal: true, taxTotal: true, total: true,
        advancePaid: true, settlementStatus: true, externalOrderRef: true, externalPlacedAt: true, createdAt: true, channelId: true, channel: { select: { kind: true, name: true } },
        items: { select: { quantity: true, lineTotal: true, unitCost: true } },
        costLines: { select: { kind: true, amount: true } },
        // Claims nobody has verified yet: shown separately, NEVER cash.
        payments: { where: { status: "PENDING", kind: "ADVANCE" }, select: { amount: true } },
        settlements: { select: { amount: true, receivedOn: true, legacyAssumed: true }, orderBy: { receivedOn: "asc" } },
      },
    }),
    prisma.expense.findMany({ where: { spentOn: { gte: dateFrom, lte: dateTo }, ...(params.channelId ? { channelId: params.channelId } : {}) }, select: { category: true, amount: true, channelId: true } }),
    prisma.financialIncident.findMany({ where: { occurredOn: { gte: dateFrom, lte: dateTo } }, select: { kind: true, orderId: true, lossAmount: true, refundAmount: true, courierFee: true } }),
    params.channelId || params.status ? Promise.resolve([] as { totalCost: unknown }[]) : prisma.procurementReceipt.findMany({ where: { createdAt: { gte: range.start, lte: range.end } }, select: { totalCost: true } }),
  ]);
  const truncated = orderRows.length > MAX_REPORT_ORDERS;
  const rows = truncated ? orderRows.slice(0, MAX_REPORT_ORDERS) : orderRows;

  const orders: AcctOrder[] = rows.map((o) => ({
    id: o.id, orderNumber: o.orderNumber, status: o.status, channelKind: o.channel.kind, channelId: o.channelId, channelName: o.channel.name, externalOrderRef: o.externalOrderRef,
    placedOn: dhakaDay(o.externalPlacedAt ?? o.createdAt),
    paymentMethod: o.paymentMethod, fulfillmentMode: o.fulfillmentMode,
    subtotal: Number(o.subtotal), discountTotal: Number(o.discountTotal), shippingTotal: Number(o.shippingTotal), taxTotal: Number(o.taxTotal), total: Number(o.total),
    advancePaid: Number(o.advancePaid), settlementStatus: o.settlementStatus, paymentStatus: o.paymentStatus,
    items: o.items.map((i) => ({ quantity: i.quantity, lineTotal: Number(i.lineTotal), unitCost: i.unitCost === null ? null : Number(i.unitCost) })),
    costLines: o.costLines.map((c) => ({ kind: c.kind, amount: Number(c.amount) })),
    pendingClaims: o.payments.map((p) => Number(p.amount)),
    settlements: o.settlements.map((s) => ({ amount: Number(s.amount), receivedOn: isoDay(s.receivedOn), legacyAssumed: s.legacyAssumed })),
  }));

  // For each incident: does its order still count as a sale (compensation vs cash-only), and which channel does it belong to?
  const orderIds = [...new Set(incidentRows.map((x) => x.orderId).filter((x): x is string => Boolean(x)))];
  const orderInfo = new Map<string, { status: string; channelId: string }>();
  if (orderIds.length) for (const r of await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, status: true, channelId: true } })) orderInfo.set(r.id, { status: r.status, channelId: r.channelId });
  const NON_SALE = new Set<string>(NON_SALE_STATUSES);
  const incidents: AcctIncident[] = incidentRows
    .map((x) => {
      const info = x.orderId ? orderInfo.get(x.orderId) : undefined;
      return {
        kind: x.kind, lossAmount: Number(x.lossAmount), refundAmount: Number(x.refundAmount), courierFee: Number(x.courierFee),
        orderCountsAsSale: x.orderId ? !NON_SALE.has(info?.status ?? "") : null, channelId: info?.channelId ?? null,
      };
    })
    // A channel/status-filtered view only includes incidents of its own orders.
    .filter((x) => (!params.channelId || x.channelId === params.channelId) && (!params.status || x.channelId !== null));

  // Disclosure: refunded orders whose refund amount was never recorded (cash-out is then understated).
  const refundedIds = rows.filter((o) => o.status === "REFUNDED").map((o) => o.id);
  const withRecord = new Set(incidentRows.filter((x) => x.kind === "REFUND" && x.orderId).map((x) => x.orderId));
  const missing = refundedIds.filter((id) => !withRecord.has(id)).length;

  return {
    range, orders, truncated, refundedOrdersWithoutRefundRecord: missing,
    expenses: expenseRows.map((e) => ({ category: e.category, amount: Number(e.amount), channelId: e.channelId })),
    incidents,
    receipts: receiptRows.map((r) => ({ totalCost: r.totalCost === null ? null : Number(r.totalCost) })),
  };
}

/**
 * The single loader behind the Accounts page, its CSV exports and the dashboard headline numbers, so they can never disagree.
 * Orders are selected by (marketplace placed date ?? created date) inside the Dhaka-day range.
 */
export async function getAccounting(params: { from?: string; to?: string }): Promise<AccountingResult> {
  const inputs = await loadAccountingInputs(params);
  const summary = buildFinancialSummary({ orders: inputs.orders, expenses: inputs.expenses, incidents: inputs.incidents, receipts: inputs.receipts });
  return {
    range: inputs.range, orders: inputs.orders, truncated: inputs.truncated,
    summary: { ...summary, refundedOrdersWithoutRefundRecord: inputs.refundedOrdersWithoutRefundRecord },
    refundedOrdersWithoutRefundRecord: inputs.refundedOrdersWithoutRefundRecord,
  };
}
