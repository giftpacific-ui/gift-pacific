import type { Metadata } from "next";
import Link from "next/link";
import { listCodReconciliation } from "@/server/services/courier-cod.service";
import { COD_FLAG_LABEL, COD_KIND_LABEL, type CodEntryKind, type CodFlagCode } from "@/lib/courier/cod-reconciliation";
import { CodEntryForm } from "@/features/admin/cod-entry-form";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "COD reconciliation · Admin" };
export const dynamic = "force-dynamic";

const FILTERS: { value: string; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "ANY", label: "Needs attention" },
  ...(Object.keys(COD_FLAG_LABEL) as CodFlagCode[]).map((c) => ({ value: c, label: COD_FLAG_LABEL[c] })),
];

export default async function CodReconciliationPage({ searchParams }: { searchParams: Promise<{ flag?: string; page?: string }> }) {
  const sp = await searchParams;
  const flag = FILTERS.some((f) => f.value === sp.flag) ? (sp.flag as CodFlagCode | "ANY" | "ALL") : "ANY";
  const { rows, total, page, pageCount, totals, capped } = await listCodReconciliation(flag, Number(sp.page) || 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Courier COD reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          For cash-on-delivery orders handed to a courier: what the courier should collect, what it reported, the fee it kept, and what it has paid you.
          Entries are append-only and never create revenue (the sale is already counted on the order). Fix a mistake with an adjustment.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border/70 bg-card p-4"><p className="text-sm text-muted-foreground">COD orders reviewed</p><p className="font-heading text-2xl">{totals.orders}</p></div>
        <div className="rounded-xl border border-border/70 bg-card p-4"><p className="text-sm text-muted-foreground">Needing attention</p><p className="font-heading text-2xl">{totals.flagged}</p></div>
        <div className="rounded-xl border border-border/70 bg-card p-4"><p className="text-sm text-muted-foreground">Courier still owes you</p><p className="font-heading text-2xl">{formatPrice(totals.outstanding)}</p></div>
      </div>
      {capped && <p className="text-xs text-muted-foreground">Showing the 500 most recent matching orders.</p>}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link key={f.value} href={`/admin/courier/cod?flag=${f.value}`} className={cn("rounded-full border px-3 py-1 text-xs", flag === f.value ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary")}>
            {f.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to show for this filter.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  <Link href={`/admin/orders/${r.id}`} className="text-primary hover:underline">{r.orderNumber}</Link>
                  <span className="ml-2 text-xs text-muted-foreground">{r.provider ?? "manual"}{r.tracking ? ` · ${r.tracking}` : ""}{r.deliveredAt ? ` · delivered ${formatDate(r.deliveredAt)}` : ""}</span>
                </p>
                <div className="flex flex-wrap gap-1">
                  {r.flags.length === 0 ? <Badge variant="secondary">Matched</Badge> : r.flags.map((f) => (
                    <Badge key={f.code} variant="destructive">{COD_FLAG_LABEL[f.code]} · {formatPrice(f.amount)}</Badge>
                  ))}
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                <div><dt className="text-xs text-muted-foreground">Expected cash</dt><dd>{formatPrice(r.expected)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Reported collected</dt><dd>{formatPrice(r.collected)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Courier fee kept</dt><dd>{formatPrice(r.fees)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Settled to you</dt><dd>{formatPrice(r.settled)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Still owed</dt><dd className="font-semibold">{formatPrice(r.outstanding)}</dd></div>
              </dl>
              <p className="text-xs text-muted-foreground">Delivery charge on the order: {formatPrice(r.deliveryCharge)} (for reference; the courier&apos;s own fee is recorded separately above).</p>
              {r.entries.length > 0 && (
                <ul className="space-y-1 border-t border-border/50 pt-2 text-xs">
                  {r.entries.map((e) => (
                    <li key={e.id} className="flex flex-wrap justify-between gap-2">
                      <span>{COD_KIND_LABEL[e.kind as CodEntryKind] ?? e.kind}{e.reference ? ` · ${e.reference}` : ""}{e.note ? ` — ${e.note}` : ""}</span>
                      <span>{formatPrice(e.amount)} · {formatDate(e.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <details className="text-sm">
                <summary className="cursor-pointer text-primary">Add entry</summary>
                <div className="pt-2"><CodEntryForm orderId={r.id} /></div>
              </details>
            </li>
          ))}
        </ul>
      )}
      {pageCount > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          {page > 1 ? <Link className="text-primary hover:underline" href={`/admin/courier/cod?flag=${flag}&page=${page - 1}`}>← Previous</Link> : <span />}
          <span className="text-muted-foreground">Page {page} of {pageCount} · {total} orders</span>
          {page < pageCount ? <Link className="text-primary hover:underline" href={`/admin/courier/cod?flag=${flag}&page=${page + 1}`}>Next →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
