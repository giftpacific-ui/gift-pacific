"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { retryTrackingEventAction, runTrackingMaintenanceAction } from "@/server/actions/tracking.actions";
import type { TrackingDiagnostics } from "@/server/services/tracking-diagnostics.service";

const CAPI_LABEL: Record<TrackingDiagnostics["meta"]["capiState"], string> = {
  ready: "Ready",
  no_pixel: "Not configured (no Pixel ID)",
  invalid_pixel: "Not configured (Pixel ID invalid)",
  no_token: "Not configured (access token not set on the server)",
};

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/50 py-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={ok === undefined ? "font-medium" : ok ? "font-medium text-emerald-700" : "font-medium text-amber-700"}>{value}</dd>
    </div>
  );
}

export function TrackingDiagnosticsPanel({ data }: { data: TrackingDiagnostics }) {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ success: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      (r.success ? toast.success : toast.error)(r.message);
    });
  const { meta, google, events } = data;

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-lg font-semibold">Tracking diagnostics</h3>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(runTrackingMaintenanceAction)}>
          Run delivery job now
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">Read-only status. Secrets are never shown: only whether they are set.</p>

      <dl className="mt-4 text-sm">
        <Row label="Meta Pixel (browser)" ok={meta.pixelConfigured} value={meta.pixelConfigured ? `Configured · ${meta.pixelId} (${meta.pixelSource})` : "Not configured"} />
        <Row label="Meta Conversions API (server)" ok={meta.capiState === "ready"} value={CAPI_LABEL[meta.capiState]} />
        <Row label="Graph API version" value={meta.apiVersion} />
        <Row label="Google" ok={google.configured} value={google.configured ? `${google.kind === "GA4" ? "GA4 (gtag.js)" : "Tag Manager"} (${google.source})` : "Not configured"} />
        <Row label="TikTok pixel" ok={data.tiktok.configured} value={data.tiktok.configured ? "Configured" : "Not configured"} />
        <Row label="Consent mode" value={data.consentMode === "OPT_IN" ? "Opt-in (trackers wait for consent)" : "Off (trackers load without a banner)"} />
        <Row label="Retry job (CRON_SECRET)" ok={data.retryJobEnabled} value={data.retryJobEnabled ? "Enabled" : "Disabled (CRON_SECRET missing or too short)"} />
      </dl>

      {data.missingEnv.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Missing environment variables: {data.missingEnv.join(", ")}</p>
      )}
      {data.warnings.map((w) => (
        <p key={w} className="mt-2 rounded-lg bg-muted p-3 text-sm">{w}</p>
      ))}

      <h4 className="mt-6 text-sm font-semibold">Server events, last {events.windowDays} days</h4>
      <p className="mt-1 text-sm text-muted-foreground">
        Sent {events.counts.sent} · Pending {events.counts.pending} · Failed {events.counts.failed} · Skipped {events.counts.skipped}
        {events.lastSentAt ? ` · Last delivered ${events.lastSentAt.toLocaleString()}` : ""}
      </p>
      {events.recent.length > 0 && (
        <ul className="mt-3 divide-y divide-border/60 text-sm">
          {events.recent.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{e.orderNumber}</span> · {e.eventName} · {e.status.toLowerCase()}
                {e.skipReason ? ` (${e.skipReason.replace(/_/g, " ")})` : ""} · attempts {e.attempts}
                {e.errorMessage ? <span className="block text-xs text-muted-foreground">{e.errorCode ? `${e.errorCode}: ` : ""}{e.errorMessage}</span> : null}
              </span>
              {e.retryable && (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => retryTrackingEventAction(e.id))}>
                  Retry
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
