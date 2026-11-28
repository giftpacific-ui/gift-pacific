"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { runFraudMaintenanceAction, saveFraudPolicyAction } from "@/server/actions/admin-fraud.actions";
import { CREDIT_SIGNALS, FLAT_RISK_SIGNALS, SCALED_SIGNALS, SIGNAL_LABELS, type FraudPolicy } from "@/lib/fraud/policy";

const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

function NumberField({ label, value, onChange, min, max, hint }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; hint?: string }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <Input type="number" value={Number.isNaN(value) ? "" : value} min={min} max={max} onChange={(e) => onChange(num(e.target.value))} />
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function FraudPolicyForm({ initial, admins, problem }: { initial: FraudPolicy; admins: { id: string; name: string | null; email: string }[]; problem: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [p, setP] = useState<FraudPolicy>(structuredClone(initial));
  const set = (fn: (draft: FraudPolicy) => void) => setP((cur) => { const next = structuredClone(cur); fn(next); return next; });
  const run = (fn: () => Promise<{ success: boolean; message?: string }>) =>
    start(async () => { const r = await fn(); if (r.success) { toast.success(r.message ?? "Done."); router.refresh(); } else toast.error(r.message ?? "Failed."); });

  return (
    <div className="space-y-6">
      {problem && <p className="rounded-md bg-red-50 p-3 text-sm text-red-900">The stored policy is invalid ({problem}), so the built-in defaults are in force. Save a valid policy to replace it.</p>}
      <Card>
        <CardHeader><CardTitle className="text-base">Mode and thresholds</CardTitle></CardHeader>
        <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <label className="block space-y-1"><span className="font-medium">Mode</span>
            <select className={`${selectClass} w-full`} value={p.mode} onChange={(e) => set((d) => { d.mode = e.target.value as FraudPolicy["mode"]; })}>
              <option value="ENFORCE">Enforce: hold high/critical orders for review</option>
              <option value="ADVISORY">Advisory: score and warn, never block</option>
              <option value="OFF">Off: do not evaluate</option>
            </select>
          </label>
          <NumberField label="Medium risk from (score)" value={p.thresholds.medium} min={1} max={100} onChange={(n) => set((d) => { d.thresholds.medium = n; })} hint="Default 30. Medium shows a warning only." />
          <NumberField label="High risk from (score)" value={p.thresholds.high} min={1} max={100} onChange={(n) => set((d) => { d.thresholds.high = n; })} hint="Default 60." />
          <NumberField label="Critical risk from (score)" value={p.thresholds.critical} min={1} max={100} onChange={(n) => set((d) => { d.thresholds.critical = n; })} hint="Default 80." />
          <label className="block space-y-1"><span className="font-medium">Review required from</span>
            <select className={`${selectClass} w-full`} value={p.reviewFrom} onChange={(e) => set((d) => { d.reviewFrom = e.target.value as "HIGH" | "CRITICAL"; })}>
              <option value="HIGH">High and critical</option>
              <option value="CRITICAL">Critical only</option>
            </select>
          </label>
          <label className="block space-y-1"><span className="font-medium">Blocked phone / e-mail at checkout</span>
            <select className={`${selectClass} w-full`} value={p.blockAction} onChange={(e) => set((d) => { d.blockAction = e.target.value as "HOLD" | "REJECT"; })}>
              <option value="HOLD">Accept and hold for review (recommended)</option>
              <option value="REJECT">Refuse to place the order</option>
            </select>
            <span className="block text-xs text-muted-foreground">IP blocks never refuse an order.</span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Who may review CRITICAL orders</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">Leave all unchecked to let any active admin review critical orders. Every decision needs a reason and is audited either way.</p>
          {admins.map((a) => (
            <label key={a.id} className="flex items-center gap-2">
              <input type="checkbox" checked={p.criticalReviewerIds.includes(a.id)} onChange={(e) => set((d) => { d.criticalReviewerIds = e.target.checked ? [...d.criticalReviewerIds, a.id] : d.criticalReviewerIds.filter((x) => x !== a.id); })} />
              {a.name ?? a.email} <span className="text-xs text-muted-foreground">{a.email}</span>
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Windows, counts and retention</CardTitle></CardHeader>
        <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <NumberField label="Burst window (hours)" value={p.windows.burstHours} min={1} max={168} onChange={(n) => set((d) => { d.windows.burstHours = n; })} />
          <NumberField label="Duplicate-cart window (minutes)" value={p.windows.duplicateMinutes} min={1} max={1440} onChange={(n) => set((d) => { d.windows.duplicateMinutes = n; })} />
          <NumberField label="Same-address window (days)" value={p.windows.addressDays} min={1} max={90} onChange={(n) => set((d) => { d.windows.addressDays = n; })} />
          <NumberField label="Same-e-mail window (days)" value={p.windows.emailDays} min={1} max={365} onChange={(n) => set((d) => { d.windows.emailDays = n; })} />
          <NumberField label="Same-IP window (hours)" value={p.windows.ipHours} min={1} max={168} onChange={(n) => set((d) => { d.windows.ipHours = n; })} />
          <NumberField label="Free orders before the burst signal" value={p.counts.burstFree} min={0} max={20} onChange={(n) => set((d) => { d.counts.burstFree = n; })} />
          <NumberField label="Other phones at one address to flag" value={p.counts.addressPhones} min={2} max={50} onChange={(n) => set((d) => { d.counts.addressPhones = n; })} />
          <NumberField label="Other phones on one e-mail to flag" value={p.counts.emailPhones} min={2} max={50} onChange={(n) => set((d) => { d.counts.emailPhones = n; })} />
          <NumberField label="Different phones on one IP to flag" value={p.counts.ipPhones} min={2} max={100} onChange={(n) => set((d) => { d.counts.ipPhones = n; })} hint="Shared networks are common: keep this high." />
          <NumberField label="High-value first order (BDT)" value={p.highValueAmount} min={0} onChange={(n) => set((d) => { d.highValueAmount = n; })} />
          <NumberField label="Maximum total credit (points)" value={p.maxCredit} min={0} max={100} onChange={(n) => set((d) => { d.maxCredit = n; })} />
          <NumberField label="Keep IP addresses for (days)" value={p.ipRetentionDays} min={1} max={365} onChange={(n) => set((d) => { d.ipRetentionDays = n; })} hint="Older IPs are erased; scores and reasons stay." />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Signal weights (points)</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">Every point in a score comes from one of these signals and is shown to the admin with its reason. Credits are negative. A block-list match always reaches at least its level whatever the weight.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {SCALED_SIGNALS.map((code) => (
              <div key={code} className="rounded-md border border-border/60 p-3">
                <div className="mb-2 font-medium">{SIGNAL_LABELS[code]}</div>
                <div className="flex gap-2">
                  <NumberField label="Per item" value={p.scaled[code].perUnit} min={0} max={100} onChange={(n) => set((d) => { d.scaled[code].perUnit = n; })} />
                  <NumberField label="Maximum" value={p.scaled[code].cap} min={0} max={100} onChange={(n) => set((d) => { d.scaled[code].cap = n; })} />
                </div>
              </div>
            ))}
            {[...FLAT_RISK_SIGNALS, ...CREDIT_SIGNALS].map((code) => (
              <div key={code} className="rounded-md border border-border/60 p-3">
                <NumberField label={SIGNAL_LABELS[code]} value={p.flat[code]} min={(CREDIT_SIGNALS as readonly string[]).includes(code) ? -100 : 0} max={(CREDIT_SIGNALS as readonly string[]).includes(code) ? 0 : 100} onChange={(n) => set((d) => { d.flat[code] = n; })} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => run(() => saveFraudPolicyAction(p))}>Save policy</Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => run(runFraudMaintenanceAction)}>Run retention job now</Button>
      </div>
    </div>
  );
}
