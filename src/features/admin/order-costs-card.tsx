"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { addOrderCostAction, deleteOrderCostAction } from "@/server/actions/admin-external-order.actions";
import { formatPrice } from "@/lib/utils";

const KINDS = [["COURIER_FEE", "Courier fee"], ["MARKETPLACE_COMMISSION", "Marketplace commission"], ["PAYMENT_FEE", "Payment fee"], ["PACKAGING", "Packaging"], ["OTHER", "Other"]] as const;
const NAME = Object.fromEntries(KINDS);

export function OrderCostsCard({ orderId, lines }: { orderId: string; lines: { id: string; kind: string; amount: number; note: string | null }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState("COURIER_FEE");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const run = (fn: () => Promise<{ success: boolean; message?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.success) return void toast.error(r.message ?? "Something went wrong.");
      after?.();
      router.refresh();
    });
  return (
    <section className="space-y-3 rounded-xl border border-border/70 bg-card p-5" aria-labelledby="costs-heading">
      <h2 id="costs-heading" className="font-heading text-lg">Recorded costs</h2>
      <p className="text-xs text-muted-foreground">Only amounts entered by you. Used for profit <em>estimates</em> in the channel report — revenue is never shown as profit.</p>
      {lines.length === 0 && <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>}
      <ul className="space-y-1.5">
        {lines.map((l) => (
          <li key={l.id} className="flex items-center justify-between text-sm">
            <span>{NAME[l.kind as keyof typeof NAME] ?? l.kind}{l.note ? ` — ${l.note}` : ""}</span>
            <span className="flex items-center gap-2">{formatPrice(l.amount)}
              <button type="button" aria-label="Delete cost" disabled={pending} onClick={() => run(() => deleteOrderCostAction(orderId, l.id))}><Trash2 className="size-4 text-destructive" /></button>
            </span>
          </li>
        ))}
        {lines.length > 0 && <li className="flex justify-between border-t border-border pt-1.5 text-sm font-medium"><span>Total recorded</span><span>{formatPrice(total)}</span></li>}
      </ul>
      <div className="grid gap-2">
        <select aria-label="Cost type" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
        <Input type="number" min={0} step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input placeholder="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        <Button size="sm" disabled={pending || amount.trim() === ""} onClick={() => run(() => addOrderCostAction(orderId, { kind, amount: Number(amount), note }), () => { setAmount(""); setNote(""); })}>Add cost</Button>
      </div>
    </section>
  );
}
