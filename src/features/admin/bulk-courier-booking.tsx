"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatDate, formatPrice } from "@/lib/utils";
import { bulkBookCourierAction } from "@/server/actions/admin-courier.actions";
import type { BulkBookingResult } from "@/server/services/courier.service";

type Row = { id: string; orderNumber: string; status: string; total: number; paymentMethod: string; courierBookingStatus: string; lastError: string | null; createdAt: string };

export function BulkCourierBooking({ rows, limit, ready, providers }: { rows: Row[]; limit: number; ready: boolean; providers: { key: string; label: string }[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<BulkBookingResult[] | null>(null);
  const [pending, startTransition] = useTransition();
  const [provider, setProvider] = useState(providers[0]?.key ?? "");

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else if (next.size < limit) next.add(id);
      return next;
    });

  function run() {
    startTransition(async () => {
      const result = await bulkBookCourierAction([...selected], provider || undefined);
      if (!result.success) return void toast.error(result.message);
      setResults(result.results);
      setSelected(new Set());
      const count = (st: string) => result.results.filter((r) => r.status === st).length;
      toast.message(`${count("booked")} booked, ${count("failed")} failed, ${count("skipped")} skipped, ${count("pending")} not attempted yet`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {!ready && <p className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-sm">Courier API booking is not configured, so bookings below will be refused. Set the courier environment variables first.</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">{selected.size} selected (max {limit} at a time)</p>
        <div className="flex flex-wrap items-center gap-2">
          {providers.length > 1 && (
            <select aria-label="Courier" value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm">
              {providers.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          )}
          <Button type="button" disabled={pending || selected.size === 0} onClick={run}>{pending ? "Booking…" : "Book selected with courier"}</Button>
        </div>
      </div>

      {results && (
        <ul className="space-y-1 rounded-xl border border-border/70 bg-card p-3 text-sm" aria-label="Booking results">
          {results.map((r) => (
            <li key={r.orderId} className="flex flex-wrap justify-between gap-2">
              <span><Link href={`/admin/orders/${r.orderId}`} className="text-primary hover:underline">{r.orderNumber}</Link></span>
              <span className={r.status === "booked" ? "text-emerald-700" : r.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                {r.status === "booked" ? "✓ Booked: " : r.status === "failed" ? "✗ Failed: " : r.status === "skipped" ? "– Skipped: " : "… Not attempted: "}{r.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No confirmed orders are waiting for a courier.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-border/70 text-left text-muted-foreground">
              <tr><th className="w-10 p-3"><span className="sr-only">Select</span></th><th className="p-3">Order</th><th className="p-3">Placed</th><th className="p-3">Total</th><th className="p-3">Payment</th><th className="p-3">Courier</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/40 last:border-0">
                  <td className="p-3"><input type="checkbox" aria-label={`Select ${r.orderNumber}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td className="p-3"><Link href={`/admin/orders/${r.id}`} className="text-primary hover:underline">{r.orderNumber}</Link></td>
                  <td className="p-3">{formatDate(r.createdAt)}</td>
                  <td className="p-3">{formatPrice(r.total)}</td>
                  <td className="p-3">{r.paymentMethod}</td>
                  <td className="p-3 text-xs">{r.courierBookingStatus === "FAILED" ? `Failed: ${r.lastError ?? "see order"}` : "Not booked"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
