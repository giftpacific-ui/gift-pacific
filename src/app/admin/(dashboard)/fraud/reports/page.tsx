import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/current-user";
import { getRiskReports } from "@/server/services/fraud-report.service";
import { FraudNav } from "@/features/admin/fraud-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Fraud reports · Admin" };

function Orders({ nums }: { nums: string[] }) {
  return <span className="text-xs text-muted-foreground">{nums.join(", ")}</span>;
}

export default async function AdminFraudReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const r = await getRiskReports({ from, to });
  const max = Math.max(1, ...r.trend.map((d) => d.high + d.critical));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Fraud reports</h1>
        <p className="text-sm text-muted-foreground">
          Real figures from your orders, last {days} days.{" "}
          {[7, 30, 90].map((d) => (<Link key={d} className={`mr-2 underline ${d === days ? "font-semibold" : ""}`} href={`/admin/fraud/reports?days=${d}`}>{d} days</Link>))}
        </p>
        {r.truncated && <p className="mt-1 text-sm text-amber-800">This period has more rows than the report reads; figures below are based on the most recent part of it.</p>}
      </div>
      <FraudNav active="/admin/fraud/reports" />

      <Card>
        <CardHeader><CardTitle className="text-base">Orders by risk level</CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-5">
          {(["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNASSESSED"] as const).map((k) => (<div key={k}><div className="text-xs uppercase text-muted-foreground">{k.toLowerCase()}</div><div className="text-xl font-semibold">{r.byLevel[k]}</div></div>))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">High and critical orders per day</CardTitle></CardHeader>
        <CardContent>
          <div className="flex h-32 items-end gap-1" role="img" aria-label="High and critical risk orders per day">
            {r.trend.map((d) => (
              <div key={d.date} className="flex flex-1 flex-col justify-end" title={`${d.date}: ${d.high} high, ${d.critical} critical`}>
                <div className="bg-red-500" style={{ height: `${(d.critical / max) * 100}%` }} />
                <div className="bg-orange-400" style={{ height: `${(d.high / max) * 100}%` }} />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Orange: high · Red: critical · {r.trend[0]?.date} to {r.trend.at(-1)?.date}</p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Repeat cancellations (2 or more)</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {r.repeatCancellations.length === 0 ? <p className="text-muted-foreground">None.</p> : <ul className="space-y-1">{r.repeatCancellations.map((x) => (<li key={x.phone + x.orderNumbers[0]}>{x.phone} · {x.count} cancelled <Orders nums={x.orderNumbers} /></li>))}</ul>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Failed-delivery patterns (2 or more)</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {r.failedDeliveryPatterns.length === 0 ? <p className="text-muted-foreground">None.</p> : <ul className="space-y-1">{r.failedDeliveryPatterns.map((x) => (<li key={x.phone + x.orderNumbers[0]}>{x.phone} · {x.count} failed <Orders nums={x.orderNumbers} /></li>))}</ul>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Repeated phone, e-mail and network activity (3 or more orders)</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div><h4 className="text-xs font-semibold uppercase text-muted-foreground">Phones</h4>{r.repeatedActivity.phones.length === 0 ? <p className="text-muted-foreground">None.</p> : <ul>{r.repeatedActivity.phones.map((x) => (<li key={x.phone}>{x.phone} · {x.count} orders <Orders nums={x.orderNumbers} /></li>))}</ul>}</div>
            <div><h4 className="text-xs font-semibold uppercase text-muted-foreground">E-mails</h4>{r.repeatedActivity.emails.length === 0 ? <p className="text-muted-foreground">None.</p> : <ul>{r.repeatedActivity.emails.map((x) => (<li key={x.email}>{x.email} · {x.count} orders <Orders nums={x.orderNumbers} /></li>))}</ul>}</div>
            <div><h4 className="text-xs font-semibold uppercase text-muted-foreground">Network addresses (shared networks are common; not one customer)</h4>{r.repeatedActivity.ips.length === 0 ? <p className="text-muted-foreground">None.</p> : <ul>{r.repeatedActivity.ips.map((x) => (<li key={x.ip}>{x.ip} · {x.count} orders <Orders nums={x.orderNumbers} /></li>))}</ul>}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Review outcomes and overrides</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Approved {r.reviewOutcomes.approved} · Rejected {r.reviewOutcomes.rejected} · Waiting {r.reviewOutcomes.pending}</p>
            <p>
              Admin overrides of high/critical orders: <strong>{r.overrides.total}</strong>. Delivered {r.overrides.delivered}, failed delivery {r.overrides.failedDelivery}, cancelled {r.overrides.cancelled}, still in progress {r.overrides.inProgress}.
              {r.overrides.deliveredShare !== null ? ` ${Math.round(r.overrides.deliveredShare * 100)}% of overridden orders were delivered (closest recorded sign of a false positive).` : ""}
            </p>
          </CardContent>
        </Card>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{r.notes.map((n) => (<li key={n}>{n}</li>))}</ul>
    </div>
  );
}
