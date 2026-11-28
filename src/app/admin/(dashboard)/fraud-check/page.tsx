import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth/current-user";
import { getIntelligenceProviderStatuses, intelligenceSettings } from "@/server/services/courier-intelligence.service";
import { FraudCheckClient } from "@/features/admin/fraud-check-client";
import { freshness } from "@/features/admin/courier-intelligence-report";

export const metadata: Metadata = { title: "Courier fraud check · Admin" };
export const dynamic = "force-dynamic";

const STATE: Record<string, { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "bg-emerald-50 text-emerald-900" },
  configured_unverified: { label: "Configured, not yet verified", tone: "bg-amber-50 text-amber-900" },
  error: { label: "Error on last lookup", tone: "bg-destructive/10 text-destructive" },
  not_configured: { label: "Not configured", tone: "bg-secondary text-muted-foreground" },
  unsupported: { label: "Not supported by the courier", tone: "bg-secondary text-muted-foreground" },
};

export default async function CourierFraudCheckPage() {
  await requireAdmin();
  const statuses = await getIntelligenceProviderStatuses();
  const s = intelligenceSettings();
  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Courier fraud check</h1>
        <p className="text-sm text-muted-foreground">
          How parcels sent to a phone number ended at the couriers: delivered and cancelled counts, per courier and combined. Check any Bangladesh mobile number, whether or not it has ever ordered here.
          The customer risk score and its reasons are read from this website&apos;s stored assessments. Admin-only. Courier history is evidence for staff, never a verdict: a low rate, or a courier that is unavailable or unsupported, never rejects an order.
        </p>
      </div>

      <section aria-label="Courier connections" className="grid gap-3 md:grid-cols-3">
        {statuses.map((p) => (
          <div key={p.key} className="space-y-1.5 rounded-xl border border-border/70 bg-card p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{p.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${STATE[p.state].tone}`}>{STATE[p.state].label}</span>
            </div>
            <p className="text-xs text-muted-foreground">{p.summary}</p>
            <p className="text-[11px] text-muted-foreground">Parcel booking credentials: {p.bookingConfigured ? "set" : p.key === "steadfast" ? "not set" : "n/a"} (a separate capability from this lookup).</p>
            {p.problem && <p className="text-xs text-amber-900">{p.problem}</p>}
            {p.lastSuccessAt && <p className="text-[11px] text-muted-foreground">Last successful lookup {freshness(p.lastSuccessAt)}.</p>}
            {p.lastFailureAt && p.state === "error" && <p className="text-[11px] text-destructive">Last failure {freshness(p.lastFailureAt)} ({p.lastFailureReason ?? "error"}).</p>}
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer text-primary">Documentation and limits</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {p.endpoint && <li>Endpoint: {p.endpoint}</li>}
                <li>{p.verification.state === "vendor_documented" ? "Contract taken from the courier's own published client." : "No documented lookup."} Checked {p.verification.verifiedOn}; a real call has {p.verification.liveTested ? "" : "NOT "}been tested.</li>
                <li>{p.verification.source}</li>
                <li>Reports: {p.supportedMetrics.length ? p.supportedMetrics.join(", ") : "nothing"}. Does not report: {p.unsupportedMetrics.join(", ") || "n/a"}.</li>
                <li>{p.semantics}</li>
              </ul>
            </details>
          </div>
        ))}
      </section>

      <FraudCheckClient />

      <p className="text-xs text-muted-foreground">
        Results are saved ({s.cacheSeconds === 0 ? "cache off" : `reused for ${s.cacheSeconds} s`}) and a fresh lookup adds a new saved result; earlier ones stay for audit. Only counts are kept, with a keyed hash of the number, never the number itself or the courier&apos;s raw reply.
        Each courier is limited to {s.maxCallsPerMinute} lookups a minute, and every manual lookup is audited with the masked number only.
        Counts are provider-reported records and cannot be matched between couriers, so combined totals are not deduplicated.
      </p>
    </div>
  );
}
