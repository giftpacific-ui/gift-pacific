import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/current-user";
import { getQueueCounts, getReviewQueue } from "@/server/services/fraud-report.service";
import { FraudNav } from "@/features/admin/fraud-nav";
import { RiskBadge } from "@/features/admin/risk-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/utils";
import type { RiskLevel } from "@/lib/fraud/policy";

export const metadata: Metadata = { title: "Fraud review · Admin" };
const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";

export default async function AdminFraudPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const level = sp.level === "HIGH" || sp.level === "CRITICAL" || sp.level === "MEDIUM" ? (sp.level as RiskLevel) : undefined;
  const state = sp.state === "reviewed" || sp.state === "all" ? sp.state : "pending";
  const [counts, queue] = await Promise.all([getQueueCounts(), getReviewQueue({ levels: level ? [level] : undefined, state, search: sp.q })]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Fraud review</h1>
        <p className="text-sm text-muted-foreground">
          Orders held because their risk score reached the review level. Open an order to see every reason with its points and to approve or reject it with a recorded reason.
          Scores are evidence for your decision, not a verdict, and are never shown to customers.
        </p>
      </div>
      <FraudNav active="/admin/fraud" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><div className="text-xs uppercase text-muted-foreground">Waiting for review</div><div className="text-2xl font-semibold">{counts.total}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs uppercase text-muted-foreground">Critical (on hold)</div><div className="text-2xl font-semibold text-red-700">{counts.critical}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs uppercase text-muted-foreground">High</div><div className="text-2xl font-semibold text-orange-700">{counts.high}</div></CardContent></Card>
      </div>

      <form className="flex flex-wrap items-end gap-2" method="get">
        <Input name="q" defaultValue={sp.q ?? ""} placeholder="Order number, phone or e-mail" className="w-72" />
        <select name="level" defaultValue={level ?? ""} className={selectClass} aria-label="Risk level">
          <option value="">High + critical</option>
          <option value="CRITICAL">Critical</option>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium</option>
        </select>
        <select name="state" defaultValue={state} className={selectClass} aria-label="State">
          <option value="pending">Waiting for review</option>
          <option value="reviewed">Reviewed</option>
          <option value="all">All</option>
        </select>
        <Button type="submit">Filter</Button>
      </form>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          {queue.rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No orders match.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr><th className="p-3">Order</th><th className="p-3">Risk</th><th className="p-3">Status</th><th className="p-3">Total</th><th className="p-3">Phone</th><th className="p-3">Placed</th><th className="p-3">Review</th></tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {queue.rows.map((o) => (
                  <tr key={o.id}>
                    <td className="p-3"><Link className="font-medium underline" href={`/admin/orders/${o.id}`}>{o.orderNumber}</Link></td>
                    <td className="p-3"><RiskBadge level={o.riskLevel as RiskLevel | null} score={o.riskScore} /></td>
                    <td className="p-3">{o.status.toLowerCase().replace(/_/g, " ")}</td>
                    <td className="p-3">{formatPrice(o.total)}</td>
                    <td className="p-3"><Link className="underline" href={`/admin/fraud/customers?order=${o.id}`}>{o.phone}</Link></td>
                    <td className="p-3">{new Date(o.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                    <td className="p-3">{o.riskReviewedAt ? (o.riskReviewDecision ?? "").toLowerCase() : o.riskReviewRequired ? "required" : "not required"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">Showing {queue.rows.length} of {queue.total}.</p>
    </div>
  );
}
