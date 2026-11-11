"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { refreshCourierStatusAction } from "@/server/actions/admin-courier.actions";

export type AttentionRow = {
  id: string; orderNumber: string; status: string; reason: "uncertain" | "stale_booking" | "silent_shipment" | "failed";
  consignmentId: string | null; lastStatus: string | null; lastEventAt: string | null; lastError: string | null;
};

const WHY: Record<AttentionRow["reason"], string> = {
  uncertain: "The booking request got no clear answer. The parcel may or may not exist at the courier — check the courier portal before booking again.",
  stale_booking: "A booking started but never finished (the app may have restarted). Check the courier portal, then book again or enter details by hand.",
  silent_shipment: "In transit, but no update from the courier for several days. Check the status or contact the courier.",
  failed: "The courier rejected the booking. Fix the details and book again, or enter courier details by hand.",
};

export function CourierAttentionList({ rows }: { rows: AttentionRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (rows.length === 0) return <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Nothing needs attention: no uncertain, stuck or silent courier orders.</p>;
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.id} className="space-y-2 rounded-xl border border-border/70 bg-card p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link href={`/admin/orders/${r.id}`} className="font-medium underline">{r.orderNumber}</Link>
            <span className="text-muted-foreground">{r.status.replaceAll("_", " ").toLowerCase()}{r.lastStatus ? ` · courier: ${r.lastStatus}` : ""}{r.lastEventAt ? ` · ${new Date(r.lastEventAt).toLocaleDateString("en-GB")}` : ""}</span>
          </div>
          <p className="text-muted-foreground">{WHY[r.reason]}</p>
          {r.lastError && <p className="text-xs text-destructive">{r.lastError}</p>}
          <div className="flex gap-2">
            {r.consignmentId && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
                const res = await refreshCourierStatusAction(r.id);
                if (res.success) toast.success(res.note ?? "Checked"); else toast.error(res.message);
                router.refresh();
              })}>Check courier now</Button>
            )}
            <Button asChild size="sm" variant="outline"><Link href={`/admin/orders/${r.id}`}>Open order</Link></Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
