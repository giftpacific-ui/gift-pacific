import type { Metadata } from "next";
import Link from "next/link";
import { getAdminDashboardStats } from "@/server/services/admin-dashboard.service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatPrice } from "@/lib/utils";
import { RevenueChart } from "@/features/admin/revenue-chart";

export const metadata: Metadata = { title: "Admin Dashboard" };

export default async function AdminDashboardPage() {
  const stats = await getAdminDashboardStats();

  const f = stats.finance;
  const cards = [
    { label: `Sales this month (order value)`, value: formatPrice(f.orderValue) },
    { label: f.profitIsComplete ? "Profit this month" : "Estimated profit (costs incomplete)", value: formatPrice(f.profit) },
    { label: "Cash received (verified)", value: formatPrice(f.cashIn) },
    { label: "COD still to collect", value: formatPrice(f.codOutstanding) },
    { label: "Marketplace payouts due", value: formatPrice(f.marketplaceReceivable) },
    { label: "Awaiting sourcing (units)", value: stats.pendingProcurementUnits },
    { label: "Unverified payment claims (not cash)", value: formatPrice(f.unverifiedClaims) },
    { label: "Total orders", value: stats.totalOrders },
    { label: "Total customers", value: stats.totalCustomers },
    { label: "Total products", value: stats.totalProducts },
    { label: "Pending orders", value: stats.pendingOrders },
    { label: "Low stock items", value: stats.lowStockProducts.length },
  ];

  return (
    <div className="space-y-8">
      <h1 className="font-heading text-2xl">Dashboard</h1>

      <p className="text-xs text-muted-foreground">Finance cards cover {stats.financeRange.from} to {stats.financeRange.to} using the same definitions as <Link href={`/admin/accounts?from=${stats.financeRange.from}&to=${stats.financeRange.to}`} className="underline">Accounts</Link>. Order date basis; see the definitions there.</p>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-normal text-muted-foreground">{card.label}</CardTitle>
            </CardHeader>
            <CardContent className="text-xl font-heading">{card.value}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle>Order value this month (all channels, sale orders)</CardTitle></CardHeader>
        <CardContent>
          <RevenueChart data={stats.revenueByDay} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Recent orders</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {stats.recentOrders.map((order) => (
              <Link
                key={order.id}
                href={`/admin/orders/${order.id}`}
                className="flex items-center justify-between rounded-lg border border-border/60 p-3 text-sm hover:bg-secondary/50"
              >
                <div>
                  <p className="font-medium">{order.orderNumber}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(order.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span>{formatPrice(Number(order.total))}</span>
                  <Badge variant="secondary">{order.status.replaceAll("_", " ")}</Badge>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Low stock products</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {stats.lowStockProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everything is well stocked.</p>
            ) : (
              stats.lowStockProducts.map((product) => (
                <Link
                  key={product.id}
                  href={`/admin/products/${product.id}`}
                  className="flex items-center justify-between rounded-lg border border-border/60 p-3 text-sm hover:bg-secondary/50"
                >
                  <span>{product.name}</span>
                  <Badge variant={product.stock === 0 ? "destructive" : "secondary"}>
                    {product.stock} left
                  </Badge>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
