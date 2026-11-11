import "server-only";
import { prisma } from "@/lib/db/prisma";
import { orderDateWhere } from "@/server/services/accounting.service";
import { MAX_REPORT_ORDERS, buildSalesReport, type ReportOrder, type ReportRange } from "@/lib/report";

export async function getReportOrders(range: ReportRange): Promise<{ orders: ReportOrder[]; truncated: boolean }> {
  const rows = await prisma.order.findMany({
    where: orderDateWhere(range), // same order-date rule as the Accounts page
    orderBy: { createdAt: "desc" },
    take: MAX_REPORT_ORDERS + 1,
    select: {
      orderNumber: true, createdAt: true, status: true, paymentStatus: true, subtotal: true, discountTotal: true,
      shippingTotal: true, taxTotal: true, total: true, email: true, phone: true, deliveryZone: true,
      courierName: true, trackingNumber: true, shippingSnapshot: true,
      items: { select: { productId: true, productName: true, quantity: true, lineTotal: true } },
    },
  });
  const truncated = rows.length > MAX_REPORT_ORDERS;
  return { orders: (truncated ? rows.slice(0, MAX_REPORT_ORDERS) : rows) as ReportOrder[], truncated };
}

export async function getSalesReport(range: ReportRange) {
  const { orders, truncated } = await getReportOrders(range);
  return { report: buildSalesReport(orders), truncated };
}
