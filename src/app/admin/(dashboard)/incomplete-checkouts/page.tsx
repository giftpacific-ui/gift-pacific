import type { Metadata } from "next";
import Link from "next/link";
import { adminListIncompleteCheckouts } from "@/server/services/incomplete-checkout.service";
import { RECOVERY_STATUS_LABEL, recoveryConfig } from "@/lib/checkout-recovery";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/shared/pagination";
import { CleanupButton } from "@/features/admin/incomplete-checkout-cleanup-button";
import { formatDate, formatPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "Incomplete checkouts · Admin" };

const selectCls = "h-9 rounded-[4px] border border-input bg-background px-2 text-sm";

export default async function IncompleteCheckoutsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { items, total, page, pageCount, counts } = await adminListIncompleteCheckouts({ q: sp.q, status: sp.status, kind: sp.kind, page: sp.page ? Number(sp.page) : 1 });
  const cfg = recoveryConfig();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">Incomplete checkouts ({total})</h1>
          <p className="text-sm text-muted-foreground">
            Checkouts customers started and agreed to have saved, with a valid e-mail or phone. For your information only: nothing is sent to customers. Open: {counts.ACTIVE} · Recovered: {counts.CONVERTED} · Expired: {counts.EXPIRED}.
          </p>
          <p className="text-xs text-muted-foreground">
            Saving is {cfg.enabled ? "on" : "off"}. Open records idle for {cfg.expiryDays} days expire and lose their personal details; expired records are deleted {cfg.purgeDays} days later. Records linked to an order are kept.
          </p>
        </div>
        <CleanupButton />
      </div>

      <form className="flex flex-wrap items-center gap-2">
        <Input name="q" defaultValue={sp.q} placeholder="Search name, email or phone…" className="max-w-xs" />
        <select name="status" defaultValue={sp.status ?? ""} className={selectCls} aria-label="Status">
          <option value="">All statuses</option>
          <option value="ACTIVE">Not recovered</option>
          <option value="CONVERTED">Recovered (order placed)</option>
          <option value="EXPIRED">Expired</option>
        </select>
        <select name="kind" defaultValue={sp.kind ?? ""} className={selectCls} aria-label="Customer type">
          <option value="">Guests and customers</option>
          <option value="guest">Guests</option>
          <option value="customer">Signed-in customers</option>
        </select>
        <button className="h-9 rounded-[4px] border border-border px-3 text-sm hover:bg-secondary">Filter</button>
      </form>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No incomplete checkouts match.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
          <table className="w-full min-w-200 text-sm">
            <thead className="border-b border-border/70 text-left text-muted-foreground">
              <tr>
                <th className="p-3">Customer / contact</th>
                <th className="p-3">Cart</th>
                <th className="p-3">Estimated value</th>
                <th className="p-3">Last activity</th>
                <th className="p-3">Recovery status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-border/50 align-top last:border-0 hover:bg-secondary/40">
                  <td className="p-3">
                    <Link href={`/admin/incomplete-checkouts/${r.id}`} className="font-medium hover:underline">
                      {r.customerName || r.email || r.phone || "Details removed"}
                    </Link>
                    <p className="text-xs text-muted-foreground">{[r.email, r.phone].filter(Boolean).join(" · ") || "—"}</p>
                    <p className="text-xs text-muted-foreground">{r.kind === "customer" ? "Signed-in customer" : "Guest"}</p>
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {r.itemCount} item{r.itemCount === 1 ? "" : "s"}
                    <p className="max-w-60 truncate text-xs">{r.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}</p>
                  </td>
                  <td className="p-3">{formatPrice(r.estimatedTotal)}</td>
                  <td className="p-3 text-muted-foreground">{formatDate(r.lastActivityAt)}</td>
                  <td className="p-3">
                    <Badge variant={r.status === "CONVERTED" ? "success" : r.status === "EXPIRED" ? "secondary" : "outline"}>{RECOVERY_STATUS_LABEL[r.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageCount={pageCount} basePath="/admin/incomplete-checkouts" searchParams={sp} />
    </div>
  );
}
