import { cn, formatDate } from "@/lib/utils";
import type { TimelineEntry } from "@/lib/courier/timeline";

const DOT: Record<TimelineEntry["tone"], string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/50",
};

/**
 * The shipment timeline of one order, newest first: booking attempts (created / rejected / unconfirmed), hand-entered details,
 * "the courier confirmed a parcel exists" recoveries, and every courier status notification. Display only: the entries come from
 * buildShipmentTimeline (no customer data, no secrets).
 */
export function CourierTimeline({ entries }: { entries: (Omit<TimelineEntry, "at"> & { at: Date | string })[] }) {
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No shipment activity yet. Bookings, hand entries and courier updates will appear here.</p>;
  }
  return (
    <ol className="space-y-2" aria-label="Shipment timeline">
      {entries.map((e) => (
        <li key={e.id} className="flex gap-2 text-xs">
          <span aria-hidden className={cn("mt-1 size-2 shrink-0 rounded-full", DOT[e.tone])} />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap justify-between gap-x-2">
              <span className="font-medium text-foreground">{e.title}</span>
              <time className="text-muted-foreground" dateTime={new Date(e.at).toISOString()}>{formatDate(e.at)}</time>
            </p>
            {e.detail && <p className="text-muted-foreground">{e.detail}</p>}
            {e.outcomeLabel && <p className="text-muted-foreground/80">{e.outcomeLabel}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
