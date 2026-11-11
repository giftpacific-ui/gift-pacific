import type { Metadata } from "next";
import Link from "next/link";
import { getAccountOverview } from "@/server/services/account.service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatPrice } from "@/lib/utils";
import { orderStatusBadgeVariant, orderStatusLabel } from "@/lib/order-status";
import { listRewardsForUser } from "@/server/services/reward.service";
import { getMyRecentlyViewed } from "@/server/services/recently-viewed.service";
import { ProductCard } from "@/features/products/product-card";

export const metadata: Metadata = { title: "My Account" };

export default async function AccountDashboardPage() {
  const { user, totalOrders, recentOrders, wishlistCount, orderSummary, unreadNotifications, addressCount, mainAddress } = await getAccountOverview();
  // Independent reads run together (one round trip each, nothing fetched twice).
  const [rewards, recentlyViewed] = await Promise.all([listRewardsForUser(user.id), getMyRecentlyViewed(4)]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-2xl">Welcome back, {user.name.split(" ")[0]}</h1>
        <p className="text-sm text-muted-foreground">Here&apos;s a quick look at your account.</p>
      </div>

      {rewards.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Your delivery rewards</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {rewards.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 p-3">
                <div>
                  <p className="font-medium">{r.percent}% off delivery{r.maxDiscount !== null ? ` (up to ${formatPrice(r.maxDiscount)})` : ""}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.minOrderAmount > 0 ? `Orders of ${formatPrice(r.minOrderAmount)}+ · ` : ""}{r.expiresAt ? `${r.status === "AVAILABLE" ? "valid until" : "expires"} ${formatDate(r.expiresAt)}` : "no expiry"} · choose it at checkout
                  </p>
                </div>
                <Badge variant={r.status === "AVAILABLE" ? "default" : "secondary"}>{r.status === "AVAILABLE" ? "Available" : r.status === "USED" ? "Used" : r.status === "EXPIRED" ? "Expired" : "Withdrawn"}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/account/orders" className="rounded-xl border border-border/70 bg-card p-4 hover:bg-secondary/40">
          <p className="text-sm text-muted-foreground">Preparing</p>
          <p className="font-heading text-3xl">{orderSummary.preparing}</p>
        </Link>
        <Link href="/account/orders" className="rounded-xl border border-border/70 bg-card p-4 hover:bg-secondary/40">
          <p className="text-sm text-muted-foreground">On the way</p>
          <p className="font-heading text-3xl">{orderSummary.onTheWay}</p>
        </Link>
        <Link href="/account/orders" className="rounded-xl border border-border/70 bg-card p-4 hover:bg-secondary/40">
          <p className="text-sm text-muted-foreground">Delivered</p>
          <p className="font-heading text-3xl">{orderSummary.delivered}</p>
        </Link>
        <Link href="/account/notifications" className="rounded-xl border border-border/70 bg-card p-4 hover:bg-secondary/40">
          <p className="text-sm text-muted-foreground">Unread notifications</p>
          <p className="font-heading text-3xl">{unreadNotifications}</p>
        </Link>
      </div>
      {orderSummary.needsAttention > 0 && (
        <p className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-sm">
          {orderSummary.needsAttention} order{orderSummary.needsAttention === 1 ? " needs" : "s need"} your attention.{" "}
          <Link href="/account/orders" className="font-medium text-primary hover:underline">Review orders</Link>
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Wishlist</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="font-heading text-3xl">{wishlistCount}</p>
            <Link href="/account/wishlist" className="text-primary hover:underline">{wishlistCount === 0 ? "Start saving pieces" : "View wishlist"}</Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Saved addresses</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {mainAddress ? (
              <p className="text-muted-foreground">{mainAddress.fullName}, {mainAddress.line1}, {mainAddress.city}{addressCount > 1 ? ` · +${addressCount - 1} more` : ""}</p>
            ) : (
              <p className="text-muted-foreground">No saved address yet.</p>
            )}
            <Link href="/account/settings?tab=addresses" className="text-primary hover:underline">{mainAddress ? "Manage addresses" : "Add an address"}</Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Account</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="truncate text-muted-foreground">{user.email}</p>
            <p className="text-muted-foreground">{totalOrders} order{totalOrders === 1 ? "" : "s"} placed</p>
            <Link href="/account/settings" className="text-primary hover:underline">Edit profile</Link>
          </CardContent>
        </Card>
      </div>

      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-xl">Recent orders</h2>
          <Link href="/account/orders" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        {recentOrders.length === 0 ? (
          <p className="text-sm text-muted-foreground">You haven&apos;t placed any orders yet.</p>
        ) : (
          <div className="space-y-3">
            {recentOrders.map((order) => (
              <Link
                key={order.id}
                href={`/account/orders/${order.orderNumber}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 p-4 hover:bg-secondary/50"
              >
                <div>
                  <p className="text-sm font-medium">{order.orderNumber}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(order.createdAt)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm">{formatPrice(Number(order.total))}</span>
                  <Badge variant={orderStatusBadgeVariant[order.status] ?? "secondary"}>{orderStatusLabel[order.status] ?? order.status.replaceAll("_", " ")}</Badge>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {recentlyViewed.length > 0 && (
        <div>
          <h2 className="mb-4 font-heading text-xl">Recently viewed</h2>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {recentlyViewed.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
