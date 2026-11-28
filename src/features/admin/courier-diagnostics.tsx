"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn, formatDate } from "@/lib/utils";
import { testAllCourierConnectionsAction, testCourierConnectionAction } from "@/server/actions/admin-courier.actions";
import type { CourierProviderState } from "@/lib/courier/provider-state";

/** One courier as the board shows it. Labels, flags and messages only: no credential, fingerprint or raw reply ever reaches this component. */
export type BoardProvider = {
  key: string;
  label: string;
  state: CourierProviderState;
  stateLabel: string;
  detail: string;
  adapterAvailable: boolean;
  isDefault: boolean;
  hasWebhookSecret: boolean;
  canTest: boolean;
  lastCheckedAt: Date | string | null;
  lastConnectedAt: Date | string | null;
};

const BADGE: Record<CourierProviderState, string> = {
  connected: "border-emerald-300 bg-emerald-50 text-emerald-800",
  configured: "border-sky-300 bg-sky-50 text-sky-800",
  disconnected: "border-destructive/40 bg-destructive/10 text-destructive",
  unsupported: "border-border bg-secondary text-muted-foreground",
};

type Result = { ok: boolean; message: string };

/**
 * Honest status of Steadfast, Pathao and RedX, each on its own row. "Connected" appears only after a real, recent, read-only check with the
 * current credentials; credentials alone read "Configured". Pathao and RedX have no adapter in this app, so they read "Unsupported" and
 * offer no test: bookings for them are recorded by hand.
 */
export function CourierDiagnostics({ providers, defaultMessage, cronConfigured, autoBook, invoiceLookup }: { providers: BoardProvider[]; defaultMessage: string; cronConfigured: boolean; autoBook: boolean; invoiceLookup: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Record<string, Result>>({});

  function testOne(key: string) {
    start(async () => {
      const r = await testCourierConnectionAction(key);
      setResult((x) => ({ ...x, [key]: { ok: r.success, message: r.message } }));
      router.refresh();
    });
  }
  function testAll() {
    start(async () => {
      const r = await testAllCourierConnectionsAction();
      if (!r.success) {
        setResult((x) => ({ ...x, all: { ok: false, message: r.message } }));
      } else {
        setResult(Object.fromEntries(r.results.filter((e) => e.outcome !== "unsupported").map((e) => [e.key, { ok: e.outcome === "connected", message: e.message }])));
      }
      router.refresh();
    });
  }

  const testable = providers.filter((p) => p.canTest);
  return (
    <section className="space-y-3 rounded-xl border border-border/70 bg-card p-4 text-sm" aria-label="Courier providers">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base">Courier providers</h2>
        <Button size="sm" variant="outline" disabled={pending || testable.length === 0} onClick={testAll}>
          {pending ? "Testing…" : "Test all connections"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{defaultMessage}</p>
      {result.all && <p className="text-xs text-destructive" role="status">{result.all.message}</p>}

      <ul className="space-y-3">
        {providers.map((p) => (
          <li key={p.key} className="space-y-1 rounded-lg border border-border/60 p-3" data-provider={p.key}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {p.label}
                <span className={cn("rounded-full border px-2 py-0.5 text-xs font-normal", BADGE[p.state])} data-state={p.state}>{p.stateLabel}</span>
                {p.isDefault && <span className="rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground">Default</span>}
              </span>
              {p.canTest && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => testOne(p.key)}>
                  {pending ? "Testing…" : "Test connection"}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{p.detail}</p>
            {p.adapterAvailable && (
              <>
                <p className="text-xs text-muted-foreground">
                  {p.lastCheckedAt ? `Last connection check: ${formatDate(p.lastCheckedAt)}.` : "No connection check has been made."}
                  {p.lastConnectedAt ? ` Last successful: ${formatDate(p.lastConnectedAt)}.` : ""}
                </p>
                <p className="text-xs text-muted-foreground">Status webhook: {p.hasWebhookSecret ? "bearer token set" : "no token set (webhook endpoint answers 404)"}</p>
              </>
            )}
            {result[p.key] && <p className={result[p.key].ok ? "text-xs text-emerald-700" : "text-xs text-destructive"} role="status">{result[p.key].message}</p>}
          </li>
        ))}
      </ul>

      <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
        <li>Scheduled sync: {cronConfigured ? "CRON_SECRET is set — an external scheduler must call /api/courier/reconcile (see the handoff for frequency)" : "CRON_SECRET missing or too short: the scheduled job cannot run"}.</li>
        <li>Automatic booking after confirmation: {autoBook ? "ENABLED" : "off"}.</li>
        <li>Uncertain-booking lookup by order number: {invoiceLookup ? "enabled" : "off (needs STEADFAST_INVOICE_LOOKUP=true, confirmed on staging first)"}.</li>
        <li>A connection check only proves the credentials are accepted. Nothing has been verified against the live courier until a real test booking is made.</li>
      </ul>
    </section>
  );
}
