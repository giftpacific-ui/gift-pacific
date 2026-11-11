"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { addExpenseAction, deleteExpenseAction } from "@/server/actions/admin-external-order.actions";
import { formatPrice } from "@/lib/utils";

type Expense = { id: string; spentOn: string; category: string; amount: number; channelId: string | null; note: string | null };

export function ExpensesManager({ expenses, channels, today }: { expenses: Expense[]; channels: { id: string; name: string }[]; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState({ spentOn: today, category: "", amount: "", channelId: "", note: "" });
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const run = (fn: () => Promise<{ success: boolean; message?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.success) return void toast.error(r.message ?? "Something went wrong.");
      after?.();
      router.refresh();
    });
  return (
    <div className="space-y-6">
      <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 sm:grid-cols-5">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Date<Input type="date" value={f.spentOn} onChange={(e) => setF({ ...f, spentOn: e.target.value })} /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Category<Input value={f.category} placeholder="Facebook ads, rent…" maxLength={60} onChange={(e) => setF({ ...f, category: e.target.value })} /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Amount<Input type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Channel (optional)
          <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={f.channelId} onChange={(e) => setF({ ...f, channelId: e.target.value })}>
            <option value="">Not channel-specific</option>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div className="flex items-end"><Button disabled={pending || !f.category.trim() || !f.amount} onClick={() => run(() => addExpenseAction({ spentOn: f.spentOn, category: f.category, amount: Number(f.amount), channelId: f.channelId || null, note: f.note }), () => setF({ ...f, category: "", amount: "" }))}>Add expense</Button></div>
      </div>
      <ul className="space-y-1.5">
        {expenses.length === 0 && <li className="text-sm text-muted-foreground">No expenses in this period.</li>}
        {expenses.map((e) => (
          <li key={e.id} className="flex items-center justify-between rounded-lg border border-border/60 bg-card px-4 py-2 text-sm">
            <span>{e.spentOn} · {e.category}{e.channelId ? ` · ${channels.find((c) => c.id === e.channelId)?.name ?? ""}` : ""}</span>
            <span className="flex items-center gap-3">{formatPrice(e.amount)}<button type="button" aria-label="Delete expense" disabled={pending} onClick={() => run(() => deleteExpenseAction(e.id))}><Trash2 className="size-4 text-destructive" /></button></span>
          </li>
        ))}
        {expenses.length > 0 && <li className="flex justify-between px-4 pt-2 text-sm font-medium"><span>Total</span><span>{formatPrice(total)}</span></li>}
      </ul>
    </div>
  );
}
