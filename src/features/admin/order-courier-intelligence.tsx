"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { recheckFraudAction } from "@/server/actions/admin-advance.actions";
import { HistoryOverview, ProviderReportCard, ProviderWarnings, freshness } from "@/features/admin/courier-intelligence-report";
import { RiskSummary } from "@/features/admin/risk-summary";
import { providerDescriptor } from "@/lib/courier-intelligence/registry";
import { INTEL_PROVIDERS } from "@/lib/courier-intelligence/types";
import { isDisplayedProvider } from "@/lib/courier-intelligence/view";
import type { HistoryView } from "@/lib/courier-intelligence/view";
import type { RiskView } from "@/lib/fraud/risk-view";
import type { OrderIntelligencePanel } from "@/server/services/courier-intelligence-admin.service";

const STATE_TEXT: Record<string, string> = {
  rated: "Rated",
  no_history: "No history on record",
  insufficient: "Not enough evidence to rely on",
  unavailable: "Couriers unavailable",
  invalid_phone: "Invalid phone",
};

/**
 * Order page section. Three different things are kept apart on purpose:
 *   A. EXTERNAL courier history (what the couriers report for the delivery phone),
 *   B. INTERNAL Gift Pacific order history (this website's own orders only),
 *   C. the P4 fraud risk score and its signals (the Fraud review panel).
 * Opening the page never calls a courier: it shows what is saved, with its age. Rechecking asks the couriers again and ADDS a new saved,
 * timestamped result (the order-time evidence and earlier rechecks are kept).
 */
export function OrderCourierIntelligence({ orderId, data, history, risk }: { orderId: string; data: OrderIntelligencePanel; history: HistoryView | null; risk: RiskView | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const stored = data.stored;
  const hasStored = stored?.reports.some((r) => r.status === "ok" || r.status === "no_history" || r.status === "unavailable");
  return (
    <Card>
      <CardHeader><CardTitle>Courier delivery history</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">A · External courier history</p>
          <p className="text-xs text-muted-foreground">Phone checked: {data.phoneMasked ?? "not available (no valid delivery phone)"} (the delivery phone on this order).</p>
        </div>

        {stored ? (
          <>
            {hasStored && history ? (
              <>
                <HistoryOverview view={history} />
                <ProviderWarnings view={history} />
              </>
            ) : (
              <p className="rounded-lg bg-secondary/50 p-3 text-xs">No courier result is saved for this phone yet.</p>
            )}
            <div className="grid gap-2 md:grid-cols-3">
              {INTEL_PROVIDERS.map((p) => {
                const r = stored.reports.find((x) => x.provider === p) ?? null;
                // A courier with no history lookup (nothing is ever asked of it) is not shown.
                return isDisplayedProvider(p, r) ? <ProviderReportCard key={p} provider={p} report={r} showWarning={false} /> : null;
              })}
            </div>
            {data.unchecked.filter((p) => isDisplayedProvider(p, null)).length > 0 && (
              <p className="text-xs text-amber-900">Not checked yet for this phone: {data.unchecked.filter((p) => isDisplayedProvider(p, null)).map((p) => providerDescriptor(p).label).join(", ")}. Use “Recheck couriers”.</p>
            )}
          </>
        ) : (
          <p className="rounded-lg bg-secondary/50 p-3 text-xs">There is no valid delivery phone on this order, so no courier history can be looked up.</p>
        )}

        {data.atCheckout && (
          <div className="rounded-lg border border-border/60 p-3 text-xs space-y-1">
            <p className="font-medium">At checkout (frozen with the order)</p>
            <p>
              {data.atCheckout.rate !== null ? `Delivery success rate ${data.atCheckout.rate}%` : "Unrated"} · {STATE_TEXT[data.atCheckout.state] ?? data.atCheckout.state} ·{" "}
              {data.atCheckout.sample} parcel{data.atCheckout.sample === 1 ? "" : "s"} counted · couriers: {data.atCheckout.providers.length ? data.atCheckout.providers.join(", ") : "none contributed"}
              {data.atCheckout.checkedAt ? ` · checked ${freshness(data.atCheckout.checkedAt)}` : ""}
            </p>
            <p className="text-muted-foreground">
              Minimum {data.atCheckout.policy.minSample} parcels and {data.atCheckout.policy.minProviders} courier(s) were required. {data.atCheckout.rewardAllowed ? "A good record could lower the advance." : "A good record could not lower the advance for this order."}
            </p>
          </div>
        )}
        {data.rechecks.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {data.rechecks.map((r, i) => (
              <li key={`${r.at}-${i}`}>Recheck {r.at ? freshness(r.at) : ""}: {r.rate === null ? "unrated" : `rate ${r.rate}%`} ({r.tier ?? "n/a"} tier, {r.status || "n/a"}). Earlier results are kept.</li>
            ))}
          </ul>
        )}
        <Button
          variant="outline" className="rounded-full" disabled={pending || !stored}
          onClick={() => start(async () => {
            const r = await recheckFraudAction({ orderId });
            if (!r.success) return void toast.error(r.message);
            toast.success("Couriers rechecked: a new result was saved");
            router.refresh();
          })}
        >
          <SearchCheck className="mr-2 size-4" /> {pending ? "Checking the couriers…" : "Recheck couriers"}
        </Button>
        <p className="text-[11px] text-muted-foreground">A recheck saves a new timestamped result. It never changes the advance, a waiver or a review decision.</p>

        <div className="space-y-1 border-t border-border/50 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">B · Internal Gift Pacific order history</p>
          {data.internal ? (
            <p className="text-xs">
              This customer&apos;s orders on this website: {data.internal.total} total · {data.internal.delivered} delivered · {data.internal.cancelled} cancelled · {data.internal.failedDelivery} failed delivery.
              <span className="text-muted-foreground"> These are our own orders, not courier history, and they never feed the courier rate. </span>
              <Link href={`/admin/fraud/customers?order=${orderId}`} className="text-primary underline">Full customer lookup</Link>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Not available.</p>
          )}
        </div>
        <div className="space-y-1 border-t border-border/50 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">C · Customer risk score and reasons</p>
          <RiskSummary view={risk} compact />
          <p className="text-[11px] text-muted-foreground">The review decision form is in the Fraud risk card. Courier history is one input to a human decision: an unavailable courier never rejects or cancels an order.</p>
        </div>
      </CardContent>
    </Card>
  );
}
