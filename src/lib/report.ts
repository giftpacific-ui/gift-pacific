/**
 * Sales report maths + CSV, kept pure so they are unit-tested.
 *
 * Definitions (also shown on the report page):
 *  - "Sales" = orders that still count as business: everything except
 *    CANCELLED, REFUNDED and FAILED_DELIVERY.
 *  - "Delivered" = DELIVERED orders (cash collected on delivery).
 *  - Revenue figures are the order totals (after discounts, incl. delivery
 *    charge and tax). Orders are grouped by the day they were PLACED.
 */
export const NON_SALE_STATUSES = ["CANCELLED", "REFUNDED", "FAILED_DELIVERY"] as const;
export const MAX_REPORT_DAYS = 366;
export const MAX_REPORT_ORDERS = 20_000;

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

// ---- date range (store time, inclusive days) --------------------------------

export type ReportRange = { from: string; to: string; start: Date; end: Date; days: number; adjusted: boolean };

const isoDay = (ms: number) => new Date(ms + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
function dayStartMs(day: string): number | null {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return Date.UTC(y, mo - 1, d) - DHAKA_OFFSET_MS;
}

/** Parses ?from=&to= (YYYY-MM-DD). Invalid/missing → last 30 days; reversed → swapped; capped at 366 days. */
export function parseReportRange(from: unknown, to: unknown, now: Date = new Date()): ReportRange {
  const todayStart = dayStartMs(isoDay(now.getTime()))!;
  let a = typeof from === "string" ? dayStartMs(from) : null;
  let b = typeof to === "string" ? dayStartMs(to) : null;
  let adjusted = false;

  if (a === null || b === null) {
    b = todayStart;
    a = todayStart - 29 * DAY_MS;
    adjusted = typeof from === "string" || typeof to === "string";
  }
  if (a > b) [a, b] = [b, a];
  if ((b - a) / DAY_MS + 1 > MAX_REPORT_DAYS) {
    a = b - (MAX_REPORT_DAYS - 1) * DAY_MS;
    adjusted = true;
  }
  return {
    from: isoDay(a),
    to: isoDay(b),
    start: new Date(a),
    end: new Date(b + DAY_MS - 1),
    days: Math.round((b - a) / DAY_MS) + 1,
    adjusted,
  };
}

// ---- aggregation -----------------------------------------------------------------

export type ReportOrder = {
  orderNumber: string;
  createdAt: Date;
  status: string;
  paymentStatus: string;
  subtotal: unknown;
  discountTotal: unknown;
  shippingTotal: unknown;
  taxTotal: unknown;
  total: unknown;
  email: string;
  phone: string;
  deliveryZone: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  shippingSnapshot: unknown;
  items: { productId: string; productName: string; quantity: number; lineTotal: unknown }[];
};

export type SalesReport = {
  orderCount: number;
  salesCount: number;
  grossSales: number;
  discounts: number;
  shipping: number;
  tax: number;
  netRevenue: number;
  averageOrderValue: number;
  deliveredCount: number;
  deliveredRevenue: number;
  notCountedCount: number;
  byStatus: Record<string, number>;
  topProducts: { productId: string; name: string; quantity: number; revenue: number }[];
};

const isSale = (status: string) => !(NON_SALE_STATUSES as readonly string[]).includes(status);

export function buildSalesReport(orders: readonly ReportOrder[], topN = 10): SalesReport {
  const byStatus: Record<string, number> = {};
  const products = new Map<string, { productId: string; name: string; quantity: number; revenue: number }>();
  let gross = 0, discounts = 0, shipping = 0, tax = 0, net = 0, delivered = 0, deliveredRevenue = 0, sales = 0;

  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    if (!isSale(o.status)) continue;
    sales += 1;
    gross += num(o.subtotal);
    discounts += num(o.discountTotal);
    shipping += num(o.shippingTotal);
    tax += num(o.taxTotal);
    net += num(o.total);
    if (o.status === "DELIVERED") {
      delivered += 1;
      deliveredRevenue += num(o.total);
    }
    for (const item of o.items) {
      const entry = products.get(item.productId) ?? { productId: item.productId, name: item.productName, quantity: 0, revenue: 0 };
      entry.quantity += item.quantity;
      entry.revenue += num(item.lineTotal);
      entry.name = item.productName;
      products.set(item.productId, entry);
    }
  }

  return {
    orderCount: orders.length,
    salesCount: sales,
    grossSales: round2(gross),
    discounts: round2(discounts),
    shipping: round2(shipping),
    tax: round2(tax),
    netRevenue: round2(net),
    averageOrderValue: sales > 0 ? round2(net / sales) : 0,
    deliveredCount: delivered,
    deliveredRevenue: round2(deliveredRevenue),
    notCountedCount: orders.length - sales,
    byStatus,
    topProducts: [...products.values()]
      .map((p) => ({ ...p, revenue: round2(p.revenue) }))
      .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue || a.name.localeCompare(b.name))
      .slice(0, topN),
  };
}

// ---- CSV ---------------------------------------------------------------------------------

/**
 * One CSV cell. Text beginning with = + - @ (or tab/CR) is prefixed with an
 * apostrophe so Excel/Sheets never evaluates it as a formula — customer
 * names, addresses and product names are untrusted input ("=HYPERLINK(...)").
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n"; // BOM so Excel reads UTF-8 (Bangla names) correctly
}

const localDateTime = (d: Date) => new Date(d.getTime() + DHAKA_OFFSET_MS).toISOString().replace("T", " ").slice(0, 16);

function customerName(snapshot: unknown): string {
  if (typeof snapshot === "object" && snapshot !== null && typeof (snapshot as { fullName?: unknown }).fullName === "string") {
    return (snapshot as { fullName: string }).fullName;
  }
  return "";
}

export function ordersCsv(orders: readonly ReportOrder[]): string {
  return toCsv(
    ["Order number", "Placed (Dhaka time)", "Status", "Payment status", "Customer", "Phone", "Email", "Delivery zone", "Items", "Subtotal", "Discount", "Shipping", "Tax", "Total", "Courier", "Tracking number"],
    orders.map((o) => [
      o.orderNumber, localDateTime(o.createdAt), o.status, o.paymentStatus, customerName(o.shippingSnapshot), o.phone, o.email,
      o.deliveryZone ?? "", o.items.reduce((n, i) => n + i.quantity, 0), round2(num(o.subtotal)), round2(num(o.discountTotal)),
      round2(num(o.shippingTotal)), round2(num(o.taxTotal)), round2(num(o.total)), o.courierName ?? "", o.trackingNumber ?? "",
    ]),
  );
}

export function topProductsCsv(report: SalesReport): string {
  return toCsv(["Product", "Units sold", "Revenue"], report.topProducts.map((p) => [p.name, p.quantity, p.revenue]));
}
