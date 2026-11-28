import type { Metadata } from "next";
import Link from "next/link";
import { ABANDONED_PERIODS, listAbandonedCarts, parseAbandonedHours } from "@/server/services/abandoned-cart.service";
import { formatDate, cn } from "@/lib/utils";
import { getReminderStates } from "@/server/services/abandoned-cart-email.service";
import { AbandonedCartList } from "@/features/admin/email-queue/abandoned-cart-list";
import { EMAIL_MANUAL_MAX_CARTS } from "@/lib/email/queue-policy";

export const metadata: Metadata = { title: "Abandoned carts · Admin" };
// "Send reminders" is a server action that runs inside this page's function: the Hobby limit declared here bounds it. (A literal, as Next.js requires; keep it equal to the request budget in src/lib/email/queue-policy.ts.)
export const maxDuration = 60;

const label = (h: number) => (h < 24 ? `${h}h` : `${h / 24} day${h === 24 ? "" : "s"}`);

export default async function AbandonedCartsPage({ searchParams }: { searchParams: Promise<{ hours?: string; page?: string }> }) {
  const sp = await searchParams;
  const hours = parseAbandonedHours(sp.hours);
  const { carts, total, page, pageCount } = await listAbandonedCarts(hours, Number(sp.page) || 1);
  const reminders = await getReminderStates(carts.map((c) => ({ id: c.id, lastActivity: c.lastActivity })));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Abandoned carts</h1>
        <p className="text-sm text-muted-foreground">
          Carts that still contain items and have had no activity for the chosen time. Customers who placed an order afterwards are left out. Nothing is sent to customers unless you select carts and click "Send reminders": only customers with valid marketing consent are mailed, and nothing is detected or sent in the background.
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
        <AbandonedCartList
          hours={hours}
          selectionLimit={EMAIL_MANUAL_MAX_CARTS}
          carts={carts.map((cart) => {
            const state = reminders.get(cart.id);
            return { id: cart.id, customer: cart.customer, lastActivityLabel: formatDate(cart.lastActivity), itemCount: cart.itemCount, items: cart.items, reminder: state ? { status: state.status, label: state.label } : null };
          })}
        />
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
