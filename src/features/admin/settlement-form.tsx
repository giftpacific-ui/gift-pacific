"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { recordSettlementAction } from "@/server/actions/admin-accounts.actions";

const input = "h-9 rounded-md border border-input bg-background px-2 text-sm";

/** Records a payout that ACTUALLY arrived. Nothing is pre-filled as "received": the amount, date and reference are typed from the marketplace statement. */
export function SettlementForm({ orderId, remaining }: { orderId: string; remaining: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [receivedOn, setReceivedOn] = useState("");
  const [reference, setReference] = useState("");
  // One key per form opening: a double-click or retry of the same submission cannot create a second entry.
  const key = useRef<string>("");

  if (!open) {
    return <Button size="sm" variant="outline" onClick={() => { key.current = crypto.randomUUID(); setOpen(true); }}>Record payout received</Button>;
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-[11px] text-muted-foreground">Amount received
        <input className={`${input} w-28`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`up to ${remaining}`} />
      </label>
      <label className="grid gap-1 text-[11px] text-muted-foreground">Received on
        <input className={input} type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
      </label>
      <label className="grid gap-1 text-[11px] text-muted-foreground">Payout reference
        <input className={`${input} w-36`} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="statement / payout id" />
      </label>
      <Button size="sm" disabled={pending} onClick={() => start(async () => {
        const r = await recordSettlementAction({ orderId, amount: Number(amount), receivedOn, reference, idempotencyKey: key.current });
        if (r.success) { toast.success("Payout recorded"); setOpen(false); setAmount(""); setReference(""); router.refresh(); } else toast.error(r.message);
      })}>{pending ? "Saving…" : "Save payout"}</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
}
