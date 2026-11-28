"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { combineReports } from "@/lib/courier-intelligence/combine";
import type { IntelProviderKey, ProviderReport } from "@/lib/courier-intelligence/types";
import { buildHistoryView, displayedProviders } from "@/lib/courier-intelligence/view";
import { checkCourierProviderAction, lookupPhoneRiskAction, type PhoneRiskResult } from "@/server/actions/admin-courier-intelligence.actions";
import { HistoryOverview, ProviderReportCard, ProviderWarnings } from "@/features/admin/courier-intelligence-report";
import { RiskSummary } from "@/features/admin/risk-summary";

type Slot = { report: ProviderReport | null; checking: boolean; error: string | null };
/** Only the couriers that have a history lookup are asked (and shown); the others are never queried. */
const ASKED: IntelProviderKey[] = displayedProviders();
const slotsOf = (checking: boolean): Partial<Record<IntelProviderKey, Slot>> => Object.fromEntries(ASKED.map((p) => [p, { report: null, checking, error: null } as Slot]));

/**
 * Manual lookup for ANY Bangladesh mobile number. Each courier is its own server action, so each card shows its own loading state and a
 * failure in one never hides another. The combined figure is the same pure function the server uses, applied to the reports the server returned
 * (display only: nothing here decides anything). The customer risk is read from stored records on the server: no courier is called for it.
 */
export function FraudCheckClient() {
  const [phone, setPhone] = useState("");
  const [slots, setSlots] = useState(() => slotsOf(false));
  const [masked, setMasked] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [risk, setRisk] = useState<PhoneRiskResult | null>(null);
  const [riskChecking, setRiskChecking] = useState(false);
  const busy = ASKED.some((p) => slots[p]?.checking) || riskChecking;

  async function run(fresh: boolean) {
    setMessage(null);
    setMasked(null);
    setRisk(null);
    setSlots(slotsOf(true));
    setRiskChecking(true);
    const riskRun = lookupPhoneRiskAction({ phone }).then((r) => { setRisk(r); setRiskChecking(false); });
    await Promise.all([
      riskRun,
      ...ASKED.map(async (provider) => {
        const r = await checkCourierProviderAction({ phone, provider, fresh });
        setSlots((s) => {
          if (!r.success) return { ...s, [provider]: { report: null, checking: false, error: r.message } };
          return { ...s, [provider]: { report: r.phoneValid ? r.report : null, checking: false, error: null } };
        });
        if (r.success && !r.phoneValid) setMessage("That is not a valid Bangladesh mobile number (use 01XXXXXXXXX or +8801XXXXXXXXX).");
        if (r.success && r.phoneMasked) setMasked(r.phoneMasked);
        if (!r.success) setMessage(r.message);
      }),
    ]);
  }

  const reports = ASKED.map((p) => slots[p]?.report ?? null).filter((r): r is ProviderReport => r !== null);
  const done = !busy && reports.length > 0;
  const view = done ? buildHistoryView(reports, combineReports(reports)) : null;
  // The server already built the display-ready risk (stored records only); nothing is recomputed here.
  const riskView = risk && risk.success && risk.phoneValid ? risk.risk : null;
  return (
    <div className="space-y-4">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(false); }}>
        <label className="grid gap-1 text-sm font-medium">Bangladesh mobile number
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" maxLength={20} placeholder="01XXXXXXXXX" className="w-64" />
        </label>
        <Button type="submit" disabled={busy || phone.trim().length < 10}>{busy ? "Checking…" : "Check"}</Button>
        <Button type="button" variant="outline" disabled={busy || phone.trim().length < 10} onClick={() => void run(true)}>Refresh from the couriers</Button>
      </form>
      {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
      {masked && <p className="text-xs text-muted-foreground">Number checked: {masked}{busy ? " · checking…" : ""}</p>}
      {view && (
        <div className="space-y-3">
          <HistoryOverview view={view} />
          <ProviderWarnings view={view} />
        </div>
      )}
      {(busy || done || ASKED.some((p) => slots[p]?.error)) && (
        <div className="grid gap-3 md:grid-cols-3">
          {ASKED.map((p) => (
            <div key={p}>
              {slots[p]?.error ? <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{slots[p]?.error}</p> : <ProviderReportCard provider={p} report={slots[p]?.report ?? null} checking={slots[p]?.checking} showWarning={false} />}
            </div>
          ))}
        </div>
      )}
      {risk && !risk.success && <p role="alert" className="text-sm text-destructive">{risk.message}</p>}
      {risk && risk.success && risk.phoneValid && (
        <section className="space-y-2 rounded-xl border border-border/70 bg-card p-4 text-sm" aria-label="Customer risk" data-customer-risk>
          <h2 className="font-heading text-base">Customer risk score and reasons</h2>
          <RiskSummary view={risk.riskMode === "OFF" ? null : riskView} orderLabel={risk.riskOrderNumber} />
          {risk.riskMode !== "OFF" && !risk.risk && <p className="text-xs text-muted-foreground">This website has no risk assessment for this phone (it has not ordered here, or no order was assessed).</p>}
          {risk.internal && (
            <p className="text-xs text-muted-foreground">
              This website&apos;s own orders for this phone: {risk.internal.total} total · {risk.internal.delivered} delivered · {risk.internal.cancelled} cancelled · {risk.internal.failedDelivery} failed delivery. These are our own orders, not courier history.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
