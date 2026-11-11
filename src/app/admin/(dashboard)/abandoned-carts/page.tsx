import type { Metadata } from "next";
import Link from "next/link";
import { ABANDONED_PERIODS, listAbandonedCarts, parseAbandonedHours } from "@/server/services/abandoned-cart.service";
import { formatDate, cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Abandoned carts · Admin" };

const label = (h: number) => (h < 24 ? `${h}h` : `${h / 24} day${h === 24 ? "" : "s"}`);

export default async function AbandonedCartsPage({ searchParams }: { searchParams: Promise<{ hours?: string; page?: string }> }) {
  const sp = await searchParams;
  const hours = parseAbandonedHours(sp.hours);
  const { carts, total, page, pageCount } = await listAbandonedCarts(hours, Number(sp.page) || 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Abandoned carts</h1>
        <p className="text-sm text-muted-foreground">
          Carts that still contain items and have had no activity for the chosen time. Customers who placed an order afterwards are left out. This list is for your information: nothing is sent to customers.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="No activity for">
        <span className="text-sm text-muted-foreground">No activity for</span>
        {ABANDONED_PERIODS.map((h) => (
          <Link key={h} href={`/admin/abandoned-carts?hours=${h}`} className={cn("rounded-full border px-3 py-1 text-sm", hours === h ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary")}>
            {label(h)}
          </Link>
        ))}
      </div>

      {carts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No abandoned carts for this period.</p>
      ) : (
        <ul className="space-y-3">
          {carts.map((cart) => (
            <li key={cart.id} className="space-y-2 rounded-xl border border-border/70 bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <p className="font-medium">{cart.customer ? `${cart.customer.name} · ${cart.customer.email}` : "Guest visitor"}</p>
                <p className="text-xs text-muted-foreground">{cart.itemCount} item{cart.itemCount === 1 ? "" : "s"} · last activity {formatDate(cart.lastActivity)}</p>
              </div>
              <ul className="text-sm text-muted-foreground">
                {cart.items.map((item, i) => (
                  <li key={i}>
                    {item.quantity}× {item.name}{item.variant ? ` — ${item.variant}` : ""}{item.unavailable ? " (no longer available)" : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {pageCount > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          {page > 1 ? <Link className="text-primary hover:underline" href={`/admin/abandoned-carts?hours=${hours}&page=${page - 1}`}>← Previous</Link> : <span />}
          <span className="text-muted-foreground">Page {page} of {pageCount} · {total} carts</span>
          {page < pageCount ? <Link className="text-primary hover:underline" href={`/admin/abandoned-carts?hours=${hours}&page=${page + 1}`}>Next →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
