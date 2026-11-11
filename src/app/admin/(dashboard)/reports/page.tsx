import type { Metadata } from "next";
import Link from "next/link";
import { getSalesReport } from "@/server/services/admin-report.service";
import { MAX_REPORT_ORDERS, parseReportRange } from "@/lib/report";
import { formatPrice } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Reports · Admin" };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-heading text-xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const range = parseReportRange(sp.from, sp.to);
  const { report, truncated } = await getSalesReport(range);
  const qs = `from=${range.from}&to=${range.to}`;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl">Sales reports</h1>
      <p className="text-sm"><Link href="/admin/reports/channels" className="underline">Channel report: website vs marketplaces, costs and profit estimates →</Link></p>
          <p className="text-sm text-muted-foreground">
            {range.from} to {range.to} ({range.days} day{range.days > 1 ? "s" : ""}, store time)
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2" method="get">
          <label className="text-xs text-muted-foreground">
            From
            <input type="date" name="from" defaultValue={range.from} className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
          </label>
          <label className="text-xs text-muted-foreground">
            To
            <input type="date" name="to" defaultValue={range.to} className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
          </label>
          <Button type="submit" size="sm">Apply</Button>
        </form>
      </div>

      {range.adjusted && (
        <p className="rounded-lg bg-secondary p-3 text-sm">The date range was adjusted (invalid or longer than 366 days).</p>
      )}
      {truncated && (
        <p className="rounded-lg bg-secondary p-3 text-sm">
          More than {MAX_REPORT_ORDERS.toLocaleString()} orders matched; only the newest are included. Narrow the range.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Orders placed" value={String(report.orderCount)} hint={`${report.notCountedCount} cancelled / refunded / failed`} />
        <Stat label="Sales (counted orders)" value={String(report.salesCount)} />
        <Stat label="Revenue" value={formatPrice(report.netRevenue)} hint="After discounts, incl. delivery & tax" />
        <Stat label="Average order" value={formatPrice(report.averageOrderValue)} />
        <Stat label="Gross (before discounts)" value={formatPrice(report.grossSales)} />
        <Stat label="Discounts" value={formatPrice(report.discounts)} />
        <Stat label="Delivery charges" value={formatPrice(report.shipping)} />
        <Stat label="Delivered" value={`${report.deliveredCount} · ${formatPrice(report.deliveredRevenue)}`} hint="Cash collected on delivery" />
      </div>

      <section className="space-y-3">
        <h2 className="font-heading text-lg">Orders by status</h2>
        <ul className="flex flex-wrap gap-2 text-sm">
          {Object.entries(report.byStatus).map(([status, count]) => (
            <li key={status} className="rounded-full border border-border px-3 py-1">
              {status.replaceAll("_", " ")}: <span className="font-medium">{count}</span>
            </li>
          ))}
          {report.orderCount === 0 && <li className="text-muted-foreground">No orders in this period.</li>}
        </ul>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-lg">Top-selling products</h2>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline"><Link href={`/admin/reports/export?type=products&${qs}`} prefetch={false}>Download products CSV</Link></Button>
            <Button asChild size="sm"><Link href={`/admin/reports/export?type=orders&${qs}`} prefetch={false}>Download orders CSV</Link></Button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="border-b border-border/70 text-left text-muted-foreground">
              <tr><th className="p-3">Product</th><th className="p-3">Units</th><th className="p-3">Revenue</th></tr>
            </thead>
            <tbody>
              {report.topProducts.map((p) => (
                <tr key={p.productId} className="border-b border-border/50 last:border-0">
                  <td className="p-3">{p.name}</td><td className="p-3">{p.quantity}</td><td className="p-3">{formatPrice(p.revenue)}</td>
                </tr>
              ))}
              {report.topProducts.length === 0 && (
                <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">No sales in this period.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          &ldquo;Sales&rdquo; excludes cancelled, refunded and failed-delivery orders. Orders are grouped by the day they were placed.
        </p>
      </section>
    </div>
  );
}
