"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { saveAdvanceSettingsAction } from "@/server/actions/admin-advance.actions";

type Initial = { enabled: boolean; zones: string[]; standardAmount: number; reducedAmount: number; zeroAtFullTrust: boolean; lowBelow: number; reducedFrom: number; fullAt: number; instructions: string; reviewEnabled?: boolean; problem?: string | null };
const ZONES = [["DHAKA_CITY", "Dhaka city"], ["OUTSIDE_DHAKA", "Outside Dhaka"], ["OTHER", "Other areas"]] as const;

export function AdvanceSettingsForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState({ ...initial, standardAmount: String(initial.standardAmount), reducedAmount: String(initial.reducedAmount), lowBelow: String(initial.lowBelow), reducedFrom: String(initial.reducedFrom), fullAt: String(initial.fullAt) });
  const [error, setError] = useState<string | null>(null);
  const label = "grid gap-1.5 text-sm font-medium";

  function save() {
    setError(null);
    start(async () => {
      const r = await saveAdvanceSettingsAction({ ...f, standardAmount: Number(f.standardAmount), reducedAmount: Number(f.reducedAmount), lowBelow: Number(f.lowBelow), reducedFrom: Number(f.reducedFrom), fullAt: Number(f.fullAt) });
      if (!r.success) { setError(r.message); toast.error(r.message); return; }
      toast.success("Advance policy saved");
      router.refresh();
    });
  }
  return (
    <div className="grid max-w-2xl gap-4 rounded-xl border border-border/70 bg-card p-5 sm:grid-cols-2">
      <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Require an advance</label>
      <fieldset className="sm:col-span-2"><legend className="mb-1 text-sm font-medium">Delivery zones that need an advance</legend>
        <div className="flex flex-wrap gap-4">{ZONES.map(([k, name]) => (
          <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.zones.includes(k)} onChange={(e) => setF({ ...f, zones: e.target.checked ? [...f.zones, k] : f.zones.filter((z) => z !== k) })} />{name}</label>
        ))}</div>
      </fieldset>
      <label className={label}>Standard advance (BDT)<Input type="number" min={0} step="0.01" value={f.standardAmount} onChange={(e) => setF({ ...f, standardAmount: e.target.value })} /></label>
      <label className={label}>Reduced advance (BDT)<Input type="number" min={0} step="0.01" value={f.reducedAmount} onChange={(e) => setF({ ...f, reducedAmount: e.target.value })} /></label>
      <label className={label}>Low trust below (%) — standard advance + review flag<Input type="number" min={1} max={100} value={f.lowBelow} onChange={(e) => setF({ ...f, lowBelow: e.target.value })} /></label>
      <label className={label}>Reduced advance from (%)<Input type="number" min={1} max={100} value={f.reducedFrom} onChange={(e) => setF({ ...f, reducedFrom: e.target.value })} /></label>
      <label className={label}>Full-trust tier at (%)<Input type="number" min={1} max={100} value={f.fullAt} onChange={(e) => setF({ ...f, fullAt: e.target.value })} /></label>
      {initial.problem && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive sm:col-span-2">The saved policy was invalid ({initial.problem}). Safe built-in defaults are being used until you save a valid policy.</p>}
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.reviewEnabled !== false} onChange={(e) => setF({ ...f, reviewEnabled: e.target.checked })} /> Require a staff review before dispatch for low-trust orders (score below the low threshold) and for orders whose delivery zone does not match the address</label>
      <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" checked={f.zeroAtFullTrust} onChange={(e) => setF({ ...f, zeroAtFullTrust: e.target.checked })} /> No advance at full trust (otherwise the reduced advance applies)</label>
      <label className={`${label} sm:col-span-2`}>Payment instructions shown at checkout<Textarea rows={3} maxLength={1000} value={f.instructions} placeholder="e.g. Send the advance to bKash Personal 01XXXXXXXXX (Send Money), then enter the transaction ID." onChange={(e) => setF({ ...f, instructions: e.target.value })} /></label>
      {error && <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2"><Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save policy"}</Button></div>
    </div>
  );
}
