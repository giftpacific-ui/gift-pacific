import type { Metadata } from "next";
import Link from "next/link";
import { adminListOrders } from "@/server/services/order.service";
import { adminListChannels } from "@/server/services/external-order.service";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/shared/pagination";
import { formatDate, formatPrice } from "@/lib/utils";
import type { OrderStatus } from "@prisma/client";

export const metadata: Metadata = { title: "Orders · Admin" };

const STATUSES: OrderStatus[] = [
  "PENDING", "CONFIRMED", "PROCESSING", "SHIPPED",
  "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED_DELIVERY",
  "REFUND_REQUESTED", "REFUNDED",
];

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
    const channels = await adminListChannels();
  const { items, total, page, pageCount } = await adminListOrders({
    status: sp.status as OrderStatus | undefined,
    channelId: sp.channel,
    courier: sp.courier,
    search: sp.q,
    page: sp.page ? Number(sp.page) : 1,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl">Orders ({total})</h1>
        <Link href="/admin/orders/external/new" className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:border-foreground">Record external order</Link>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Filter by channel">
        <Link href={sp.status ? `/admin/orders?status=${sp.status}` : "/admin/orders"} className={`rounded-full border px-3 py-1 text-xs ${!sp.channel ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>All channels</Link>
        {channels.map((c) => (
          <Link key={c.id} href={`/admin/orders?channel=${c.id}${sp.status ? `&status=${sp.status}` : ""}`} className={`rounded-full border px-3 py-1 text-xs ${sp.channel === c.id ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>{c.name}</Link>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by courier booking">
        <span className="text-xs text-muted-foreground">Courier:</span>
        {[["", "All"], ["NOT_BOOKED", "Not booked"], ["BOOKED", "Booked"], ["FAILED", "Failed"], ["UNCERTAIN", "Uncertain"], ["MANUAL", "Manual"]].map(([value, label]) => {
          const params = new URLSearchParams();
          if (sp.status) params.set("status", sp.status);
          if (sp.channel) params.set("channel", sp.channel);
          if (sp.q) params.set("q", sp.q);
          if (value) params.set("courier", value);
          const href = `/admin/orders${params.size ? `?${params}` : ""}`;
          const active = (sp.courier ?? "") === value;
          return (
            <Link key={value || "all"} href={href} className={`rounded-full border px-3 py-1 text-xs ${active ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>{label}</Link>
          );
        })}
        <Link href="/admin/courier/bulk" className="ml-auto text-xs text-primary hover:underline">Bulk courier booking →</Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <form className="max-w-sm">
          <Input name="q" defaultValue={sp.q} placeholder="Search order #, marketplace #, or email…" />
        </form>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/orders"
            className={`rounded-full border px-3 py-1 text-xs ${!sp.status ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
          >
            All
          </Link>
          {STATUSES.map((status) => (
            <Link
              key={status}
              href={`/admin/orders?status=${status}${sp.channel ? `&channel=${sp.channel}` : ""}`}
              className={`rounded-full border px-3 py-1 text-xs ${sp.status === status ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
            >
              {status.replaceAll("_", " ")}
            </Link>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-border/70 text-left text-muted-foreground">
            <tr>
              <th className="p-3">Order</th>
              <th className="p-3">Channel</th>
              <th className="p-3">Customer</th>
              <th className="p-3">Date</th>
              <th className="p-3">Total</th>
              <th className="p-3">Payment</th>
              <th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((order) => (
              <tr key={order.id} className="border-b border-border/50 last:border-0 hover:bg-secondary/40">
                <td className="p-3">
                  <Link href={`/admin/orders/${order.id}`} className="font-medium hover:underline">
                    {order.orderNumber}
                  </Link>
                </td>
                <td className="p-3 text-muted-foreground">
                  {channels.find((c) => c.id === order.channelId)?.name ?? "—"}
                  {order.externalOrderRef && <span className="block text-xs">{order.externalOrderRef}</span>}
                </td>
                <td className="p-3 text-muted-foreground">{order.user?.name ?? order.email ?? "—"}</td>
                <td className="p-3 text-muted-foreground">{formatDate(order.createdAt)}</td>
                <td className="p-3">{formatPrice(Number(order.total))}</td>
                <td className="p-3"><Badge variant="outline">{order.paymentStatus}</Badge></td>
                <td className="p-3"><Badge variant="secondary">{order.status.replaceAll("_", " ")}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={pageCount} basePath="/admin/orders" searchParams={sp} />
    </div>
  );
}
