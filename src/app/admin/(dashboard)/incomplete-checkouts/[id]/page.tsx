import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { adminGetIncompleteCheckout } from "@/server/services/incomplete-checkout.service";
import { RECOVERY_STATUS_LABEL } from "@/lib/checkout-recovery";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "Incomplete checkout · Admin" };

export default async function IncompleteCheckoutDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await adminGetIncompleteCheckout(id);
  if (!r) notFound();
  const addr = [r.address.line1, r.address.line2, r.address.city, r.address.state, r.address.postalCode, r.address.country].filter(Boolean).join(", ");

  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/admin/incomplete-checkouts" className="text-sm text-primary hover:underline">← Incomplete checkouts</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-2xl">{r.customerName || r.email || r.phone || "Incomplete checkout"}</h1>
        <Badge variant={r.status === "CONVERTED" ? "success" : r.status === "EXPIRED" ? "secondary" : "outline"}>{RECOVERY_STATUS_LABEL[r.status]}</Badge>
      </div>

      <section className="space-y-1 rounded-xl border border-border/70 bg-card p-4 text-sm">
        <h2 className="font-medium">Contact</h2>
        <p>{r.kind === "customer" ? "Signed-in customer" : "Guest checkout (no account)"}{r.userId ? <> · <Link className="text-primary hover:underline" href={`/admin/customers/${r.userId}`}>view account</Link></> : null}</p>
        <p>Email: {r.email ?? "—"}</p>
        <p>Phone: {r.phone ?? "—"}</p>
        <p>Delivery: {addr || "—"}{r.deliveryZone ? ` (${r.deliveryZone.replaceAll("_", " ").toLowerCase()})` : ""}</p>
        {r.couponCode && <p>Coupon entered: {r.couponCode}</p>}
        {r.status === "EXPIRED" && <p className="text-muted-foreground">Personal details were removed when this record expired.</p>}
      </section>

      <section className="space-y-2 rounded-xl border border-border/70 bg-card p-4 text-sm">
        <h2 className="font-medium">Cart ({r.itemCount} item{r.itemCount === 1 ? "" : "s"})</h2>
        <ul className="space-y-1">
          {r.lines.map((l, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span>{l.quantity}× {l.name}{l.variant ? ` — ${l.variant}` : ""}{l.unavailable ? " (not available now)" : ""}</span>
              <span className="text-muted-foreground">{formatPrice(l.unitPrice * l.quantity)}</span>
            </li>
          ))}
        </ul>
        <p className="border-t border-border/60 pt-2">Subtotal {formatPrice(r.subtotal)} · Estimated value incl. delivery {formatPrice(r.estimatedTotal)}</p>
        <p className="text-xs text-muted-foreground">Estimate only: coupons, rewards and tax are not applied. Prices are those at the last save.</p>
      </section>

      <section className="space-y-1 rounded-xl border border-border/70 bg-card p-4 text-sm">
        <h2 className="font-medium">Timeline</h2>
        <p>Started {formatDate(r.createdAt)} · Last activity {formatDate(r.lastActivityAt)}</p>
        {r.convertedAt && <p>Order placed {formatDate(r.convertedAt)}{r.order ? <> · <Link className="text-primary hover:underline" href={`/admin/orders/${r.order.id}`}>{r.order.orderNumber}</Link> ({r.order.status.toLowerCase()}, {formatPrice(r.order.total)})</> : null}</p>}
        {r.expiredAt && <p>Expired {formatDate(r.expiredAt)}</p>}
        <p className="text-muted-foreground">Customer agreed to progress saving on {formatDate(r.consentAt)}.</p>
      </section>
    </div>
  );
}
