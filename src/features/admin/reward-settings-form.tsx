"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { saveRewardSettingsAction } from "@/server/actions/admin-rewards.actions";

type Initial = {
  rewardEnabled: boolean; rewardDeliveryPercent: number; rewardMinOrderAmount: number; rewardMaxDiscount: number | null;
  rewardValidityDays: number | null; rewardOncePerCustomer: boolean; rewardStackWithCoupon: boolean;
};

export function RewardSettingsForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState({
    enabled: initial.rewardEnabled, percent: String(initial.rewardDeliveryPercent), min: String(initial.rewardMinOrderAmount),
    max: initial.rewardMaxDiscount === null ? "" : String(initial.rewardMaxDiscount), days: initial.rewardValidityDays === null ? "" : String(initial.rewardValidityDays),
    once: initial.rewardOncePerCustomer, stack: initial.rewardStackWithCoupon,
  });
  const [error, setError] = useState<string | null>(null);
  const label = "grid gap-1.5 text-sm font-medium";

  function save() {
    setError(null);
    start(async () => {
      const r = await saveRewardSettingsAction({
        rewardEnabled: f.enabled, rewardDeliveryPercent: Number(f.percent), rewardMinOrderAmount: Number(f.min || 0),
        rewardMaxDiscount: f.max.trim() === "" ? null : Number(f.max), rewardValidityDays: f.days.trim() === "" ? null : Number(f.days),
        rewardOncePerCustomer: f.once, rewardStackWithCoupon: f.stack,
      });
      if (!r.success) { setError(r.message); toast.error(r.message); return; } // keep what was typed
      toast.success("Reward settings saved");
      router.refresh();
    });
  }

  return (
    <div className="grid max-w-2xl gap-4 rounded-xl border border-border/70 bg-card p-5 sm:grid-cols-2">
      <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Reward enabled</label>
      <label className={label}>Delivery discount (%)<Input type="number" min={1} max={100} step={1} value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} /></label>
      <label className={label}>Minimum order to earn / use (BDT)<Input type="number" min={0} step="0.01" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></label>
      <label className={label}>Maximum discount (BDT, optional)<Input type="number" min={0} step="0.01" value={f.max} placeholder="No cap" onChange={(e) => setF({ ...f, max: e.target.value })} /></label>
      <label className={label}>Valid for (days, optional)<Input type="number" min={1} step={1} value={f.days} placeholder="No expiry" onChange={(e) => setF({ ...f, days: e.target.value })} /></label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.once} onChange={(e) => setF({ ...f, once: e.target.checked })} /> Issue only once per customer (otherwise one per qualifying delivered order)</label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.stack} onChange={(e) => setF({ ...f, stack: e.target.checked })} /> Can be used together with a product coupon</label>
      {error && <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2"><Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save settings"}</Button></div>
    </div>
  );
}
