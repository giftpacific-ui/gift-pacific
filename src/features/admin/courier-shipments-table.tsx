import Link from "next/link";
import { cn, formatDate } from "@/lib/utils";
import { isSafeHttpUrl } from "@/lib/url-safety";
import { SHIPMENT_FILTERS, SHIPMENT_FILTER_LABEL, type ShipmentFilter } from "@/server/services/courier.service";

type Row = {
  id: string; orderNumber: string; status: string; courierBookingStatus: string; courierProvider: string | null; courierName: string | null;
  courierConsignmentId: string | null; trackingNumber: string | null; trackingUrl: string | null; courierLastStatus: string | null;
  courierLastSyncAt: Date | null; courierLastError: string | null;
};

export function CourierShipmentsTable({ filter, rows, counts, total, page, pageCount }: { filter: ShipmentFilter | null; rows: Row[]; counts: Record<ShipmentFilter, number>; total: number; page: number; pageCount: number }) {
  const href = (f: ShipmentFilter | "cod", p = 1) => (f === "cod" ? "/admin/courier/cod?status=PENDING" : `/admin/courier?filter=${f}${p > 1 ? `&page=${p}` : ""}`);
  return (
    <section className="space-y-3" aria-label="Shipments">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter shipments">
        {SHIPMENT_FILTERS.map((f) => (
          <Link key={f} href={href(f)} className={cn("rounded-full border px-3 py-1 text-xs", filter === f ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary")}>
            {SHIPMENT_FILTER_LABEL[f]} ({counts[f]})
          </Link>
        ))}
        <Link href={href("cod")} className="rounded-full border border-border px-3 py-1 text-xs hover:bg-secondary">COD reconciliation pending →</Link>
      </div>
      {filter && (
        rows.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">No orders in “{SHIPMENT_FILTER_LABEL[filter]}”.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground"><tr>{["Order", "Order status", "Booking", "Courier", "Consignment / tracking", "Courier status", "Last synced", "Last error"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border/50 align-top">
                    <td className="px-3 py-2"><Link href={`/admin/orders/${r.id}`} className="font-medium underline">{r.orderNumber}</Link></td>
                    <td className="px-3 py-2">{r.status.replaceAll("_", " ").toLowerCase()}</td>
                    <td className="px-3 py-2">{r.courierBookingStatus.replaceAll("_", " ").toLowerCase()}</td>
                    <td className="px-3 py-2">{r.courierName ?? r.courierProvider ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">
                      {r.courierConsignmentId ?? "—"}
                      {r.trackingNumber && <> · {r.trackingNumber}</>}
                      {r.trackingUrl && isSafeHttpUrl(r.trackingUrl) && <> · <a href={r.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">Track Parcel</a></>}
                    </td>
                    <td className="px-3 py-2">{r.courierLastStatus ? r.courierLastStatus.replaceAll("_", " ") : "—"}</td>
                    <td className="px-3 py-2">{r.courierLastSyncAt ? formatDate(r.courierLastSyncAt) : "—"}</td>
                    <td className="max-w-56 px-3 py-2 text-destructive">{r.courierLastError ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {filter && pageCount > 1 && (
        <p className="flex items-center gap-3 text-xs">
          {page > 1 && <Link className="underline" href={href(filter, page - 1)}>Previous</Link>}
          <span className="text-muted-foreground">Page {page} of {pageCount} · {total} orders</span>
          {page < pageCount && <Link className="underline" href={href(filter, page + 1)}>Next</Link>}
        </p>
      )}
    </section>
  );
}
