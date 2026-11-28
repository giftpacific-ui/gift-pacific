"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { recalculateRiskAction, reviewRiskAction } from "@/server/actions/admin-fraud.actions";
import { RiskBadge } from "@/features/admin/risk-badge";
import type { OrderFraudPanel } from "@/server/services/fraud-review.service";

const utc = (d: Date | string | null) => (d ? `${new Date(d).toISOString().replace("T", " ").slice(0, 16)} UTC` : "not recorded");

/** Fraud-risk card for the admin order page: the score, every reason with its points, the review gate and the decision form. Never shown to customers. */
export function FraudPanel({ data }: { data: OrderFraudPanel }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  if (data.mode === "OFF") return null;

  const run = (fn: () => Promise<{ success: boolean; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.success) { toast.success(r.message ?? "Done."); setReason(""); router.refresh(); }
      else toast.error(r.message ?? "Failed.");
    });
  const decide = (decision: "APPROVED" | "REJECTED") =>
    run(() => reviewRiskAction({ orderId: data.orderId, decision, reason, assessmentId: data.assessmentId ?? "" }));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Fraud risk</CardTitle>
        <RiskBadge level={data.level} score={data.score} />
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!data.assessed ? (
          <p className="text-muted-foreground">This order has not been assessed yet. It is assessed automatically when you try to confirm it.</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Score {data.score}/100 · calculated {utc(data.assessedAt)}. Levels: medium from {data.thresholds.medium}, high from {data.thresholds.high}, critical from {data.thresholds.critical}.
              {data.mode === "ADVISORY" ? " Advisory mode: this never blocks an order." : ""} The score is evidence for your decision, not a verdict.
            </p>
            {data.level === "MEDIUM" && <p className="rounded-md bg-amber-50 p-3 text-amber-900">Warning: medium risk. You can confirm normally, but check the reasons below first.</p>}
            {data.signals.length === 0 ? (
              <p>No risk signals were found.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {data.signals.map((s) => (
                  <li key={s.code} className="flex items-start justify-between gap-3 py-2">
                    <span>
                      <span className="font-medium">{s.label}</span>
                      <span className="block text-xs text-muted-foreground">{s.detail}</span>
                      {s.refs && s.refs.length > 0 && <span className="block text-xs text-muted-foreground">Related orders: {s.refs.join(", ")}</span>}
                    </span>
                    <span className={`shrink-0 font-medium ${s.points < 0 ? "text-emerald-700" : "text-red-700"}`}>{s.points > 0 ? `+${s.points}` : s.points}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.adjustments.map((a) => (
              <p key={a.code} className="text-xs text-muted-foreground">{a.detail} ({a.from} → {a.to})</p>
            ))}
          </>
        )}

        {data.reviewRequired && !data.gateOpen && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-900">
            {data.level === "CRITICAL" ? "On hold: this order needs a fraud review before it can be confirmed or dispatched." : "This order needs a fraud-risk review before it can be confirmed or dispatched."}
          </div>
        )}
        {data.review && (
          <p className="rounded-md bg-muted p-3">
            Reviewed: <strong>{data.review.decision.toLowerCase()}</strong> at {data.review.level?.toLowerCase()} risk by {data.review.byId ?? "an admin"} · {utc(data.review.at)}.
            {data.review.reason ? <span className="block text-muted-foreground">Reason: {data.review.reason}</span> : null}
          </p>
        )}

        {data.cannotReviewBecause && <p className="text-muted-foreground">{data.cannotReviewBecause}</p>}
        {data.canReview && (
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="fraud-reason">Reason for your decision (required, recorded in the audit log)</label>
            <Textarea id="fraud-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="e.g. Called the customer and confirmed the address and the order." />
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={pending || reason.trim().length < 10} onClick={() => decide("APPROVED")}>Approve (allow confirmation)</Button>
              <Button type="button" variant="destructive" disabled={pending || reason.trim().length < 10} onClick={() => decide("REJECTED")}>Reject and cancel order</Button>
            </div>
            <p className="text-xs text-muted-foreground">Approving only lifts this fraud hold. Advance-payment verification and the low-trust review are separate and still apply.</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => recalculateRiskAction(data.orderId))}>Recalculate now</Button>
          <Link className="text-sm underline" href={`/admin/fraud/customers?order=${data.orderId}`}>Customer history</Link>
        </div>

        {data.history.length > 1 && (
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Score history</h4>
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {data.history.map((h, i) => (<li key={i}>{utc(h.at)} · {h.score} ({h.level.toLowerCase()}) · {h.trigger.toLowerCase()}</li>))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
