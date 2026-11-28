import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/prisma";
import { getCustomerRiskProfile } from "@/server/services/customer-risk.service";
import { FraudNav } from "@/features/admin/fraud-nav";
import { RiskBadge } from "@/features/admin/risk-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/utils";
import { maskPhone } from "@/lib/fraud/customer-stats";
import { getStoredIntelligence } from "@/server/services/courier-intelligence.service";
import { CombinedReportView, ProviderReportCard } from "@/features/admin/courier-intelligence-report";
import { INTEL_PROVIDERS } from "@/lib/courier-intelligence/types";

export const metadata: Metadata = { title: "Customer lookup · Admin" };
const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 1000) / 10}%`);
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 16).replace("T", " ");

export default async function AdminFraudCustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const q = sp.q?.trim();
  let orderId = sp.order;
  if (!orderId && q && /^[A-Za-z]{2,}-/.test(q)) {
    orderId = (await prisma.order.findUnique({ where: { orderNumber: q }, select: { id: true } }))?.id;
  }
  const profile = orderId
    ? await getCustomerRiskProfile({ orderId })
    : q ? await getCustomerRiskProfile(q.includes("@") ? { email: q } : { phone: q }) : null;
  const searched = Boolean(orderId || q);
  // External courier history for the customer's phone: what is SAVED (no courier is called by opening this page). Kept apart from the internal history below.
  // Every phone the profile knows (contact and delivery numbers, at most three), each judged on its own.
  const externals = profile ? await Promise.all(profile.identity.phones.slice(0, 3).map((ph) => getStoredIntelligence(ph))) : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Customer lookup</h1>
        <p className="text-sm text-muted-foreground">
          History is matched on the normalised phone number, e-mail address or account, so guests are covered and different spellings of one number are the same customer. Admin-only.
        </p>
      </div>
      <FraudNav active="/admin/fraud/customers" />
      <form className="flex gap-2" method="get">
        <Input name="q" defaultValue={q ?? ""} placeholder="Phone, e-mail or order number" className="w-80" />
        <Button type="submit">Look up</Button>
      </form>

      {searched && !profile && <p className="text-sm text-muted-foreground">No matching customer or orders found.</p>}
      {profile && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Customer</CardTitle>
              {profile.currentRisk ? <RiskBadge level={profile.currentRisk.level} score={profile.currentRisk.score} /> : <RiskBadge level={null} />}
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p>Phone: {profile.identity.phones.length ? profile.identity.phones.map(maskPhone).join(", ") : "none"} · E-mail: {profile.identity.email ?? "none"} · Account: {profile.identity.userId ? "signed-in customer" : "guest"}</p>
              {profile.activeListEntries.length > 0 && (
                <p className="rounded-md bg-amber-50 p-2 text-amber-900">On a list: {profile.activeListEntries.map((e) => `${e.listType.toLowerCase()} ${e.kind.toLowerCase()} (${e.reason})`).join("; ")}</p>
              )}
              {profile.truncated && <p className="text-xs text-muted-foreground">Only the most recent orders were analysed.</p>}
            </CardContent>
          </Card>

          {externals.filter((x) => x.phoneValid).map((external) => (
            <Card key={external.phoneMasked}>
              <CardHeader><CardTitle className="text-base">External courier history · {external.phoneMasked}</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-xs text-muted-foreground">What the delivery networks report for this phone. This is NOT the website history below, and the two are never merged. Saved results only: use the order page&apos;s “Recheck couriers” or the Courier fraud check page for a fresh lookup.</p>
                <CombinedReportView combined={external.combined} reports={external.reports} />
                <div className="grid gap-2 md:grid-cols-3">{INTEL_PROVIDERS.map((p) => <ProviderReportCard key={p} provider={p} report={external.reports.find((r) => r.provider === p) ?? null} />)}</div>
                {external.unchecked.length > 0 && <p className="text-xs text-amber-900">Not checked yet for this phone: {external.unchecked.join(", ")}.</p>}
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardHeader><CardTitle className="text-base">Internal website history</CardTitle></CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Total orders", profile.stats.total], ["Confirmed", profile.stats.confirmed], ["Delivered", profile.stats.delivered], ["Cancelled", profile.stats.cancelled],
                ["Failed deliveries", profile.stats.failedDelivery], ["Cancellation rate", pct(profile.stats.cancellationRate)], ["Failed-delivery rate", pct(profile.stats.failedDeliveryRate)],
                ["Successful purchases", formatPrice(profile.stats.successfulValue)], ["Rejected in fraud review", profile.stats.fraudRejected], ["High-risk orders", profile.stats.highRisk],
                ["Critical-risk orders", profile.stats.criticalRisk], ["Admin overrides", profile.stats.overriddenApprovals],
              ].map(([k, v]) => (
                <div key={String(k)}><div className="text-xs uppercase text-muted-foreground">{k}</div><div className="text-lg font-semibold">{v}</div></div>
              ))}
              <div className="sm:col-span-2 lg:col-span-4 text-xs text-muted-foreground">
                Refused COD orders are not recorded by the system; failed deliveries are the nearest recorded outcome. Failed-delivery rate = failed ÷ (delivered + failed).
              </div>
            </CardContent>
          </Card>

          {profile.signals.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Recurring risk signals</CardTitle></CardHeader>
              <CardContent className="text-sm"><ul className="space-y-1">{profile.signals.map((s) => (<li key={s.code}>{s.label} <span className="text-muted-foreground">· in {s.orders} order{s.orders === 1 ? "" : "s"}</span></li>))}</ul></CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle className="text-base">Recent orders</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-muted-foreground"><tr><th className="p-3">Order</th><th className="p-3">Placed</th><th className="p-3">Status</th><th className="p-3">Total</th><th className="p-3">Risk</th></tr></thead>
                <tbody className="divide-y divide-border/60">
                  {profile.recentOrders.map((o) => (
                    <tr key={o.orderNumber}>
                      <td className="p-3">{o.orderNumber}</td><td className="p-3">{day(o.createdAt)}</td><td className="p-3">{o.status.toLowerCase().replace(/_/g, " ")}</td>
                      <td className="p-3">{formatPrice(o.total)}</td><td className="p-3"><RiskBadge level={o.riskLevel} score={o.riskScore} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {profile.scoreHistory.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Risk score history</CardTitle></CardHeader>
              <CardContent className="text-sm">
                <ul className="space-y-0.5">{profile.scoreHistory.map((h, i) => (<li key={i}>{day(h.at)} · {h.orderNumber} · {h.score} ({h.level.toLowerCase()}) · {h.trigger.toLowerCase()}</li>))}</ul>
              </CardContent>
            </Card>
          )}
          <p className="text-sm"><Link className="underline" href="/admin/fraud/lists">Manage block &amp; allow lists</Link></p>
        </div>
      )}
    </div>
  );
}
