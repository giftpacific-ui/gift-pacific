import type { Metadata } from "next";
import Link from "next/link";
import { getChannelReport } from "@/server/services/channel-report.service";
import { adminListChannels } from "@/server/services/external-order.service";
import type { ChannelSummary } from "@/lib/channel-report";
import { formatPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "Channel report · Admin" };

const STATUSES = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED_DELIVERY", "REFUND_REQUESTED", "REFUNDED"];

type Row = { label: string; hint?: string; strong?: boolean; value: (s: ChannelSummary) => string };
const pct = (n: number) => `${Math.round(n * 100)}%`;

const SECTIONS: { title: string; note?: string; rows: Row[] }[] = [
  {
    title: "Sales",
    note: "Sale orders only: cancelled, refunded and failed-delivery orders are excluded and counted separately.",
    rows: [
      { label: "Orders", value: (s) => String(s.orders) },
      { label: "Units sold", value: (s) => String(s.unitsSold) },
      { label: "Items subtotal", value: (s) => formatPrice(s.grossSales) },
      { label: "Discounts", value: (s) => formatPrice(s.discounts) },
      { label: "Shipping charged to customers", value: (s) => formatPrice(s.shippingCharged) },
      { label: "Revenue", hint: "What customers paid. This is NOT profit.", strong: true, value: (s) => formatPrice(s.revenue) },
      { label: "of which collected (paid)", value: (s) => formatPrice(s.collected) },
      { label: "Cancelled / refunded / failed", value: (s) => String(s.cancelledOrReturned) },
    ],
  },
  {
    title: "Costs you have recorded",
    note: "Nothing here is estimated. Unknown costs are shown as unknown, not as zero.",
    rows: [
      { label: "Product cost (where known)", value: (s) => formatPrice(s.productCost) },
      { label: "Cost known for", hint: "Share of sold items whose unit cost is known.", value: (s) => (s.itemsTotal === 0 ? "—" : `${pct(s.costCoverage)} of items`) },
      { label: "Marketplace commission", hint: "Only commissions that were entered.", value: (s) => (s.orders === 0 ? "—" : s.ordersWithCommission === 0 ? "Not recorded" : `${formatPrice(s.commissionRecorded)} (${s.ordersWithCommission}/${s.orders} orders)`) },
      { label: "Other recorded costs", value: (s) => formatPrice(s.otherRecordedCosts) },
      { label: "Courier fees", value: (s) => formatPrice(s.courierFees) },
      { label: "Expenses (ads, tools…)", value: (s) => formatPrice(s.expenses) },
    ],
  },
  {
    title: "Profit ESTIMATES",
    note: "Estimates only: revenue minus the costs above. They are as complete as your recorded costs — check “Cost known for” and the commission row.",
    rows: [
      { label: "Estimate before expenses", strong: true, value: (s) => formatPrice(s.profitEstimateBeforeExpenses) },
      { label: "Net profit estimate", strong: true, value: (s) => formatPrice(s.netProfitEstimate) },
    ],
  },
];

export default async function ChannelReportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const [report, channels] = await Promise.all([
    getChannelReport({ from: sp.from, to: sp.to, channelId: sp.channel || undefined, status: sp.status || undefined }),
    adminListChannels(),
  ]);
  const columns = [...report.channels, report.combined];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl">Channel report</h1>
        <Link href="/admin/reports" className="text-sm underline">← Sales report (CSV export)</Link>
      </div>
      <form className="flex flex-wrap items-end gap-3" aria-label="Report filters">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">From<input type="date" name="from" defaultValue={report.range.from} className="h-10 rounded-md border border-input bg-background px-3 text-sm" /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">To<input type="date" name="to" defaultValue={report.range.to} className="h-10 rounded-md border border-input bg-background px-3 text-sm" /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Channel
          <select name="channel" defaultValue={sp.channel ?? ""} className="h-10 rounded-md border border-input bg-background px-3 text-sm"><option value="">All channels</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Status
          <select name="status" defaultValue={sp.status ?? ""} className="h-10 rounded-md border border-input bg-background px-3 text-sm"><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}</select>
        </label>
        <button className="h-10 rounded-md border border-border px-4 text-sm font-medium hover:border-foreground">Show</button>
      </form>
      <p className="text-xs text-muted-foreground">
        Dates are Dhaka days. External orders use the marketplace&apos;s order date. Revenue is not profit; profit figures are labelled estimates and use only costs that were entered.
        {report.truncated && " Showing the most recent orders only — narrow the dates for complete figures."}
      </p>
      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-border/70 text-left text-muted-foreground">
            <tr><th className="p-3" scope="col"><span className="sr-only">Measure</span></th>{columns.map((c) => <th key={c.channelId ?? "all"} scope="col" className="p-3 text-right font-semibold text-foreground">{c.name}</th>)}</tr>
          </thead>
          {SECTIONS.map((section) => (
            <tbody key={section.title} className="border-b border-border/50 last:border-0">
              <tr><th colSpan={columns.length + 1} scope="colgroup" className="bg-secondary/50 p-3 text-left font-heading text-base">{section.title}{section.note && <span className="block text-xs font-normal text-muted-foreground">{section.note}</span>}</th></tr>
              {section.rows.map((row) => (
                <tr key={row.label} className="border-t border-border/40">
                  <th scope="row" className={`p-3 text-left ${row.strong ? "font-semibold" : "font-normal"}`}>{row.label}{row.hint && <span className="block text-xs font-normal text-muted-foreground">{row.hint}</span>}</th>
                  {columns.map((c) => <td key={c.channelId ?? "all"} className={`p-3 text-right tabular-nums ${row.strong ? "font-semibold" : ""}`}>{row.value(c)}</td>)}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {report.unassignedExpenses > 0 && <p className="text-xs text-muted-foreground">Expenses not tied to a channel ({formatPrice(report.unassignedExpenses)}) are included in “Combined” only.</p>}
    </div>
  );
}
