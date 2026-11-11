import "server-only";
import { WEBSITE_CHANNEL_ID } from "@/lib/channels";
import { orderValueByDay } from "@/lib/accounting";
import { prisma } from "@/lib/db/prisma";
import { getAccounting } from "@/server/services/accounting.service";

export async function getAdminDashboardStats() {
  const [
    totalOrders,
    totalCustomers,
    totalProducts,
    pendingOrders,
    trackedProducts,
    recentOrders,
    pendingProcurement,
  ] = await Promise.all([
    prisma.order.count({ where: { channelId: WEBSITE_CHANNEL_ID } }),
    prisma.user.count({ where: { role: "CUSTOMER" } }),
    prisma.product.count(),
    prisma.order.count({ where: { status: "PENDING" } }),
    // Prisma can't compare two columns of the same row in `where`, so we
    // fetch tracked products and filter for low stock in application code.
    prisma.product.findMany({
      where: { trackInventory: true, status: "ACTIVE" },
      select: { id: true, name: true, stock: true, lowStockThreshold: true },
    }),
    prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { items: true },
    }),
    prisma.product.aggregate({ _sum: { procurementPending: true } }),
  ]);

  // Finance headline numbers come from the SAME loader as the Accounts page (identical definitions, this month to date).
  const today = new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
  const finance = await getAccounting({ from: `${today.slice(0, 8)}01`, to: today });

  const lowStockProducts = trackedProducts
    .filter((p) => p.stock <= p.lowStockThreshold)
    .sort((a, b) => a.stock - b.stock)
    .slice(0, 10);

  // The chart uses the SAME orders and rule as the "Sales this month" card (order value of sale orders, all channels, by placed day).
  const revenueByDay = orderValueByDay(finance.orders);

  return {
    pendingProcurementUnits: pendingProcurement._sum.procurementPending ?? 0,
    finance: finance.summary,
    financeRange: finance.range,
    totalOrders,
    totalCustomers,
    totalProducts,
    pendingOrders,
    lowStockProducts,
    recentOrders,
    revenueByDay,
  };
}
