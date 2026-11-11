import type { Metadata } from "next";
import Link from "next/link";
import { getAccounting } from "@/server/services/accounting.service";
import { listIncidents } from "@/server/services/incident.service";
import { IncidentForm } from "@/features/admin/incident-form";
import { SettlementForm } from "@/features/admin/settlement-form";
import { listOpenReceivables } from "@/server/services/settlement.service";
import { FINANCIAL_DEFINITIONS } from "@/lib/accounting";
import { formatPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "Accounts · Admin" };
export const dynamic = "force-dynamic";

type Row = [label: string, value: string, hint?: string, strong?: boolean];

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const { range, summary: s, truncated } = await getAccounting(sp);
  const [incidents, receivables] = await Promise.all([
    listIncidents(range),
    listOpenReceivables(100),
  ]);

  const money = (n: number) => formatPrice(n);

  const sections: { title: string; note?: string; rows: Row[] }[] = [
    {
      title: "Sales (Accrual)",
      note: "Orders still counted as business: everything except Cancelled, Refunded and Failed delivery.",
      rows: [
        [
          "Orders placed / counted as sales",
          `${s.ordersPlaced} / ${s.saleOrders}`,
          `${s.excludedOrders} cancelled, refunded or failed`,
        ],
        ["Gross sales (goods)", money(s.grossSales)],
        ["Discounts", money(s.discounts)],
        ["Net sales (goods)", money(s.netSales), undefined, true],
        [
          "Delivery charges billed",
          money(s.deliveryBilled),
          "After any delivery reward",
        ],
        [
          "Tax collected",
          money(s.taxCollected),
          "Pass-through: not part of profit",
        ],
        [
          "Order value billed",
          money(s.orderValue),
          "What customers were billed. NOT cash and NOT profit.",
        ],
      ],
    },
    {
      title: "Costs",
      note: "Costs come from recorded data only. Unknown costs are never treated as zero.",
      rows: [
        [
          "Cost of goods sold",
          money(s.cogs),
          s.cogsUnknownLines
            ? `${s.cogsUnknownLines} order line(s) have no cost recorded — profit is incomplete`
            : "All sold lines have a cost snapshot",
        ],
        ...Object.entries(s.orderCosts).map(
          ([k, v]) =>
            [
              `Order cost — ${k.replaceAll("_", " ").toLowerCase()}`,
              money(v),
            ] as Row,
        ),
        ["Damage / write-off losses", money(s.incidentLosses)],
        ["Courier return / extra fees", money(s.incidentCourierFees)],
        ["Refund compensation on sales", money(s.compensation)],
        ["Operating expenses", money(s.operatingExpenses), "From Expenses"],
      ],
    },
    {
      title: s.profitIsComplete
        ? "Profit"
        : "Estimated Profit (Some costs unknown)",
      note: "Net sales + delivery billed − cost of goods − order costs − losses − return fees − compensation − expenses. Inventory purchases are cash only and never reduce profit.",
      rows: [
        ...(s.profitIsComplete ? [] : (s.profitIncompleteReasons.map((reason, i) => [`Why it is an estimate (${i + 1})`, reason] as Row))),
        ["Gross profit (net sales − goods cost)", money(s.grossProfit)],
        [
          s.profitIsComplete ? "Profit" : "Estimated profit",
          money(s.profit),
          undefined,
          true,
        ],
      ],
    },
    {
      title: "Cash (Verified)",
      note: "Verified advances, COD from delivered orders and marketplace payouts that were actually recorded as received, against recorded outgoings. Claims nobody has verified are NOT cash.",
      rows: [
        ["Advances received (verified)", money(s.advancesReceived)],
        ["COD collected (delivered orders)", money(s.codCollected)],
        ["Marketplace payouts received (actual)", money(s.marketplaceSettled), s.marketplaceLegacyAssumed ? `${money(s.marketplaceLegacyAssumed)} of this was assumed from an old "settled" flag — check it against the marketplace statement` : undefined],
        ["Cash in", money(s.cashIn), undefined, true],
        ["Refunds paid", money(s.refundsPaid), s.refundedOrdersWithoutRefundRecord ? `${s.refundedOrdersWithoutRefundRecord} refunded order(s) have no refund amount recorded` : undefined],
        ["Procurement purchases", money(s.procurementPurchases), "Only receipts where a cost was entered"],
        ["Cash out", money(s.cashOut), "Fees a marketplace withholds from payouts are not counted again here", true],
        ["Net cash movement", money(s.netCash), undefined, true],
      ],
    },
    {
      title: "Unverified claims",
      note: "A customer typed a transaction id; nobody has checked the wallet yet. Never counted as cash.",
      rows: [
        ["Claimed, not verified", money(s.unverifiedClaims), `${s.unverifiedClaimCount} claim(s) on orders that still count`],
      ],
    },
    {
      title: "Outstanding",
      rows: [
        ["Customer balance still to collect (orders in progress)", money(s.codOutstanding), "Total minus VERIFIED advance"],
        ["Marketplace expected payout", money(s.marketplaceExpectedPayout), "Total − advance − commission/fees the marketplace withholds"],
        ["Marketplace payouts still to receive", money(s.marketplaceReceivable), s.marketplacePartialOrders ? `${s.marketplacePartialOrders} order(s) partly paid` : undefined],
        ...(s.marketplaceOverReceived ? [["Received above expected", money(s.marketplaceOverReceived), "A commission line was probably lowered after payout — review"] as Row] : []),
      ],
    },
  ];

  return (
    <div className="mx-auto space-y-8 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/admin/accounts/payments" className="rounded-md border border-border px-3 py-2 font-medium hover:border-foreground">Payment reconciliation</Link>
        <Link href="/admin/courier/cod" className="rounded-md border border-border px-3 py-2 font-medium hover:border-foreground">Courier COD reconciliation</Link>
      </div>
      {/* Header Section */}
      <div className="flex flex-col gap-4 border-b border-border/60 pb-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            Accounts & Finance
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {range.from} to {range.to}. Unified definitions for dashboard,
            reports, and CSV exports.
          </p>
        </div>

        {/* Date Filter & Export Form */}
        <form className="flex flex-wrap items-center gap-3" method="get">
          <div className="flex items-center gap-2 rounded-lg border border-input bg-card p-1.5 shadow-sm">
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground px-2">
              From:{" "}
              <input
                type="date"
                name="from"
                defaultValue={range.from}
                className="h-7 rounded border border-input bg-background px-1.5 text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
            <span className="text-muted-foreground">to</span>
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground px-2">
              To:{" "}
              <input
                type="date"
                name="to"
                defaultValue={range.to}
                className="h-7 rounded border border-input bg-background px-1.5 text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>
          </div>
          <button className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            Apply
          </button>
          <Link
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium shadow-sm transition-colors hover:bg-secondary hover:text-secondary-foreground"
            href={`/admin/accounts/export?from=${range.from}&to=${range.to}`}
          >
            Download CSV
          </Link>
          <Link
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium shadow-sm transition-colors hover:bg-secondary hover:text-secondary-foreground"
            href={`/admin/accounts/export?type=orders&from=${range.from}&to=${range.to}`}
          >
            Orders CSV
          </Link>
        </form>
      </div>

      {/* Alerts */}
      {truncated && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive shadow-sm"
        >
          <span className="font-semibold">Warning:</span> This period has more
          orders than can be summed at once. Totals are INCOMPLETE — please
          choose a shorter date range.
        </div>
      )}
      {range.adjusted && (
        <p className="text-xs text-muted-foreground italic">
          * Note: Dates were automatically adjusted to a valid range (max 366
          days).
        </p>
      )}

      {/* Main Grid Sections */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {sections.map((sec) => (
          <div
            key={sec.title}
            className={`flex flex-col rounded-xl border border-border/70 bg-card p-5 shadow-sm transition-all hover:shadow-md ${
              sec.title.includes("Profit")
                ? "lg:col-span-2 bg-secondary/10 border-primary/20"
                : ""
            }`}
          >
            <div className="mb-4">
              <h2 className="font-heading text-lg font-semibold tracking-tight">
                {sec.title}
              </h2>
              {sec.note && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {sec.note}
                </p>
              )}
            </div>

            <dl className="divide-y divide-border/60">
              {sec.rows.map(([k, v, hint, strong]) => (
                <div
                  key={k}
                  className="flex items-center justify-between py-2.5 text-sm"
                >
                  <dt className="text-muted-foreground pr-4">
                    {k}
                    {hint && (
                      <span className="block text-[11px] text-muted-foreground/80 mt-0.5">
                        {hint}
                      </span>
                    )}
                  </dt>
                  <dd
                    className={`text-right font-mono ${strong ? "text-base font-bold text-foreground" : "font-medium text-foreground"}`}
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      {/* Marketplace Payouts Section */}
      <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
        <h2 className="font-heading text-lg font-semibold tracking-tight mb-1">Marketplace payouts still to receive</h2>
        <p className="mb-3 text-xs text-muted-foreground">Nothing counts as cash until you record what actually arrived. A partial payout leaves the rest listed here.</p>
        {receivables.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No pending marketplace payouts.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {receivables.map((o) => (
              <li key={o.orderId} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <span className="grid gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link className="font-medium text-primary underline-offset-4 hover:underline" href={`/admin/orders/${o.orderId}`}>{o.orderNumber}</Link>
                    <span className="text-muted-foreground">·</span>
                    <span className="font-medium">{o.channelName}</span>
                    {o.externalOrderRef && <span className="text-muted-foreground text-xs bg-secondary px-2 py-0.5 rounded">Ref: {o.externalOrderRef}</span>}
                    <span className="rounded bg-secondary px-2 py-0.5 text-xs">{o.state === "PARTIAL" ? "Partly paid" : "Awaiting payout"}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Total {money(o.total)}{o.advancePaid > 0 ? ` − advance ${money(o.advancePaid)}` : ""}{o.feesWithheld > 0 ? ` − fees ${money(o.feesWithheld)}` : ""} = expected {money(o.expected)} · received {money(o.received)} · <strong>still owed {money(o.remaining)}</strong>
                  </span>
                  {o.payouts.length > 0 && <span className="text-[11px] text-muted-foreground">Payouts: {o.payouts.map((p) => `${money(p.amount)} on ${p.receivedOn}${p.reference ? ` (${p.reference})` : ""}${p.legacyAssumed ? " [assumed]" : ""}`).join("; ")}</span>}
                </span>
                <SettlementForm orderId={o.orderId} remaining={o.remaining} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Returns, Damage, Losses and Refunds Section */}
      <section className="space-y-4 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
        <div>
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            Returns, Damage, Losses and Refunds
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Restocking needs the order line and can only return units that are
            still out; restocked goods are never counted as a loss. Write-offs
            remove units through guarded stock decrements.
          </p>
        </div>

        <IncidentForm />

        {incidents.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-left text-sm">
              <thead className="bg-secondary/60 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="p-3">Date</th>
                  <th className="p-3">What</th>
                  <th className="p-3 text-right">Units</th>
                  <th className="p-3">Stock</th>
                  <th className="p-3 text-right">Loss</th>
                  <th className="p-3 text-right">Refund</th>
                  <th className="p-3 text-right">Courier Fee</th>
                  <th className="p-3">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {incidents.map((x) => (
                  <tr
                    key={x.id}
                    className="transition-colors hover:bg-secondary/30"
                  >
                    <td className="p-3 font-mono text-xs text-muted-foreground">
                      {x.occurredOn.toISOString().slice(0, 10)}
                    </td>
                    <td className="p-3 font-medium">
                      {x.kind.replaceAll("_", " ").toLowerCase()}
                    </td>
                    <td className="p-3 text-right font-mono">{x.quantity}</td>
                    <td className="p-3 text-xs">
                      <span className="rounded bg-secondary px-2 py-0.5">
                        {x.stockEffect.toLowerCase().replace("_", " ")}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono text-destructive">
                      {money(Number(x.lossAmount))}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {money(Number(x.refundAmount))}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {money(Number(x.courierFee))}
                    </td>
                    <td className="p-3 text-muted-foreground text-xs">
                      {x.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <details className="rounded-xl border border-border/70 bg-card p-5 text-sm shadow-sm">
        <summary className="cursor-pointer font-heading text-lg font-semibold">Definitions used everywhere (Accounts, dashboard, reports, CSV)</summary>
        <dl className="mt-3 grid gap-3">
          {FINANCIAL_DEFINITIONS.map((d) => (
            <div key={d.term}><dt className="font-medium">{d.term}</dt><dd className="text-muted-foreground">{d.rule}</dd></div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">Dates: an order belongs to the day it was placed. COD and payouts are attributed to the day of their ORDER (not the day the cash arrived).</p>
      </details>
    </div>
  );
}
