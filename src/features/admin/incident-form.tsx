"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { lookupOrderLinesAction, recordIncidentAction } from "@/server/actions/admin-accounts.actions";
import { INCIDENT_KINDS } from "@/lib/incident";

const LABEL: Record<string, string> = {
  DAMAGED_BEFORE_DISPATCH: "Product damaged before dispatch", DAMAGED_IN_PACKAGING: "Damaged while packing", DAMAGED_BOX: "Box/packaging damaged",
  DAMAGED_IN_TRANSIT: "Damaged in transit", CUSTOMER_RETURN: "Customer return", FAILED_DELIVERY: "Failed / refused delivery", REFUND: "Refund paid",
  COURIER_RETURN_FEE: "Courier return / extra fee", UNSELLABLE_WRITE_OFF: "Unsellable — write off", OTHER: "Other loss",
};
type Lines = { id: string; orderNumber: string; status: string; items: { id: string; productName: string; quantity: number; stillOut: number }[] } | null;

export function IncidentForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const today = new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
  const blank = { kind: "DAMAGED_BOX", occurredOn: today, orderNumber: "", orderItemId: "", productId: "", quantity: "0", stockEffect: "NONE", loss: "0", refund: "0", courier: "0", note: "" };
  const [f, setF] = useState(blank);
  const [key, setKey] = useState(() => crypto.randomUUID()); // one key per attempt: a retry cannot record the event twice
  const [lines, setLines] = useState<Lines>(null);
  const [error, setError] = useState<string | null>(null);
  const label = "grid gap-1 text-sm font-medium";

  function lookup() {
    start(async () => {
      const r = await lookupOrderLinesAction(f.orderNumber);
      setLines(r);
      if (!r) toast.error("No order with that number.");
    });
  }
  function save() {
    setError(null);
    start(async () => {
      const r = await recordIncidentAction({
        kind: f.kind as never, occurredOn: f.occurredOn, orderId: lines?.id ?? null, orderItemId: f.orderItemId || null, productId: f.productId || null,
        quantity: Number(f.quantity), stockEffect: f.stockEffect as never, lossAmount: Number(f.loss), refundAmount: Number(f.refund), courierFee: Number(f.courier), note: f.note, idempotencyKey: key,
      });
      if (!r.success) { setError(r.message); toast.error(r.message); return; } // keep what was typed
      toast.success("Recorded");
      setF(blank); setLines(null); setKey(crypto.randomUUID()); router.refresh();
    });
  }
  return (
    <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-4 sm:grid-cols-2">
      <label className={label}>What happened
        <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{INCIDENT_KINDS.map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}</select>
      </label>
      <label className={label}>Date<Input type="date" value={f.occurredOn} max={today} onChange={(e) => setF({ ...f, occurredOn: e.target.value })} /></label>
      <div className="grid gap-1 text-sm font-medium sm:col-span-2">Order (needed for returned goods: choose the line they came from; the order must have shipped)
        <div className="flex gap-2"><Input placeholder="Order number" value={f.orderNumber} onChange={(e) => setF({ ...f, orderNumber: e.target.value })} /><Button type="button" variant="outline" disabled={pending || !f.orderNumber.trim()} onClick={lookup}>Find</Button></div>
        {lines && (
          <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={f.orderItemId} onChange={(e) => setF({ ...f, orderItemId: e.target.value })}>
            <option value="">{lines.orderNumber} ({lines.status}) — whole order / no specific line</option>
            {lines.items.map((i) => <option key={i.id} value={i.id}>{i.productName} × {i.quantity} — {i.stillOut > 0 ? `${i.stillOut} still out` : "nothing out / not shipped"}</option>)}
          </select>
        )}
      </div>
      <label className={label}>Stock effect
        <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={f.stockEffect} onChange={(e) => setF({ ...f, stockEffect: e.target.value })}>
          <option value="NONE">None (money only)</option><option value="RESTOCK">Returned units are SELLABLE: put back in stock</option><option value="DISCARD">Returned units are UNSELLABLE: keep out of stock</option><option value="WRITE_OFF">Remove units that are on my shelf (no order line)</option>
        </select>
      </label>
      <label className={label}>Units affected<Input type="number" min={0} step={1} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></label>
      <label className={label}>Product id (only if no order line is chosen; for write-offs)<Input value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })} /></label>
      <label className={label}>Loss — cost of what is gone (BDT)<Input type="number" min={0} step="0.01" value={f.loss} onChange={(e) => setF({ ...f, loss: e.target.value })} /></label>
      <label className={label}>Refund paid to customer (BDT)<Input type="number" min={0} step="0.01" value={f.refund} onChange={(e) => setF({ ...f, refund: e.target.value })} /></label>
      <label className={label}>Courier return / extra fee (BDT)<Input type="number" min={0} step="0.01" value={f.courier} onChange={(e) => setF({ ...f, courier: e.target.value })} /></label>
      <label className={`${label} sm:col-span-2`}>Note<Input value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      {error && <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2"><Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Record"}</Button></div>
    </div>
  );
}
