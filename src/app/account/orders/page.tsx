import type { Metadata } from "next";
import Link from "next/link";
import { getOrdersForCurrentUser } from "@/server/services/order.service";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDate, formatPrice } from "@/lib/utils";
import { orderStatusBadgeVariant, orderStatusLabel } from "@/lib/order-status";
import { canBuyAgain } from "@/lib/reorder-rules";
import { BuyAgainButton } from "@/features/orders/buy-again-button";

export const metadata: Metadata = { title: "My Orders" };

export default async function AccountOrdersPage() {
  const orders = await getOrdersForCurrentUser();

  return (
    <div>
      <h1 className="mb-6 font-heading text-2xl">My Orders</h1>
      {orders.length === 0 ? (
        <EmptyState title="No orders yet" description="Once you place an order, it'll show up here." />
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <div key={order.id} className="rounded-xl border border-border/70 hover:bg-secondary/30">
            <Link
              href={`/account/orders/${order.orderNumber}`}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <div>
                <p className="text-sm font-medium">{order.orderNumber}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(order.createdAt)} · {order.items.length} item
                  {order.items.length === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="outline">{order.paymentStatus.replaceAll("_", " ")}</Badge>
                <Badge variant={orderStatusBadgeVariant[order.status] ?? "secondary"}>
                  {orderStatusLabel[order.status] ?? order.status.replaceAll("_", " ")}
                </Badge>
                <span className="text-sm font-medium">{formatPrice(Number(order.total))}</span>
              </div>
            </Link>
            {canBuyAgain(order.status) && (
              <div className="px-4 pb-3">
                <BuyAgainButton orderNumber={order.orderNumber} label="Buy again" />
              </div>
            )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
