"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { applyLegacyBackorderLinksAction } from "@/server/actions/admin-inventory.actions";
import type { ReconcileReport } from "@/server/services/inventory-reconcile.service";

/** Read-only preview of old inconsistent stock data + an explicit, reviewed "apply". Nothing runs automatically. */
export function InventoryReconcileCard({ report }: { report: ReconcileReport }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { totals } = report;
  const nothing = totals.unlinkedUnits === 0 && report.anomalies.length === 0 && report.negativeStock.length === 0;
  if (nothing) return null;
  return (
    <section className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm" aria-labelledby="reconcile-h">
      <h2 id="reconcile-h" className="font-heading text-lg">Stock data check (older records)</h2>
      <p className="text-muted-foreground">
        Orders placed before the procurement update recorded back-ordered units as stock they never had. This is a <strong>preview</strong>: nothing has been changed.
        Applying only moves units on the newest not-yet-shipped order lines from &ldquo;taken from stock&rdquo; to &ldquo;awaiting procurement&rdquo;; stock quantities and the to-source totals stay the same.
      </p>
      {report.negativeStock.length > 0 && <p className="text-destructive">{report.negativeStock.length} product(s) still have negative stock — correct them with a stock adjustment after a physical count.</p>}
      {report.skus.length > 0 && (
        <ul className="space-y-2">
          {report.skus.map((s) => (
            <li key={`${s.productId}:${s.variantId ?? ""}`} className="rounded-md border border-border/60 bg-background p-3">
              <strong>{s.name}</strong>: {s.pending} to source, {s.linkedOutstanding} linked to orders, <strong>{s.unlinked} not linked to any order</strong>.
              {s.links.length > 0 ? (
                <span className="block text-xs text-muted-foreground">Would link: {s.links.map((l) => `${l.orderNumber} (${l.moveUnits} of ${l.stockDeductedBefore})`).join(", ")}{s.residual > 0 ? ` — ${s.residual} unit(s) cannot be linked (their orders already shipped): decide manually` : ""}</span>
              ) : <span className="block text-xs text-muted-foreground">No open, unshipped order can be linked ({s.residual} unit(s) need a manual decision).</span>}
            </li>
          ))}
        </ul>
      )}
      {report.anomalies.length > 0 && (
        <details><summary className="cursor-pointer font-medium">{report.anomalies.length} order line(s) to verify with a physical count</summary>
          <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">{report.anomalies.map((a) => <li key={`${a.lineId}:${a.code}`}><strong>{a.orderNumber}</strong>: {a.detail}</li>)}</ul>
        </details>
      )}
      {totals.plannedUnits > 0 && (
        <Button disabled={pending} onClick={() => { if (!confirm(`Link ${totals.plannedUnits} unit(s) to their order lines as described above? Stock quantities will not change.`)) return;
          start(async () => { const r = await applyLegacyBackorderLinksAction(totals.plannedUnits); if (r.success) { toast.success(r.message); router.refresh(); } else toast.error(r.message); }); }}>
          {pending ? "Applying…" : `Apply: link ${totals.plannedUnits} unit(s)`}
        </Button>
      )}
    </section>
  );
}
