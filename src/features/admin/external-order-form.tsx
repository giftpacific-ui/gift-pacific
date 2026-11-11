"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { createExternalOrderAction, getComboPickerAction, previewComboPriceAction, searchProductsForOrderAction, type ComboPickerData, type OrderProductHit } from "@/server/actions/admin-external-order.actions";
import { formatPrice } from "@/lib/utils";

type Line = { key: string; productId: string; variantId: string | null; name: string; quantity: number; unitPrice: string; unitCost: string; catalogCost: number | null; picker?: ComboPickerData; picks?: Record<string, number>; preview?: string };
type Channel = { id: string; name: string; kind?: string };

const label = "grid gap-1.5 text-sm font-medium";
const sel = "h-10 rounded-md border border-input bg-background px-3 text-sm";
const COST_KINDS = [
  ["MARKETPLACE_COMMISSION", "Marketplace commission"], ["PAYMENT_FEE", "Payment fee"], ["COURIER_FEE", "Courier fee"], ["PACKAGING", "Packaging"], ["OTHER", "Other"],
] as const;

export function ExternalOrderForm({ channels }: { channels: Channel[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState({ channelId: channels[0]?.id ?? "", externalOrderRef: "", externalPlacedAt: "", fullName: "", phone: "", email: "", line1: "", city: "", shippingTotal: "0", discountTotal: "0", status: "CONFIRMED", paymentStatus: "PAID", fulfillmentMode: "SELF_SHIP", stockPolicy: "DEDUCT", note: "", advanceReceived: "0", advanceMethod: "COD", advanceReference: "", settlementReceived: "0", settlementReceivedOn: "", settlementReference: "" });
  const [lines, setLines] = useState<Line[]>([]);
  const [costs, setCosts] = useState<{ kind: string; amount: string }[]>([]);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<OrderProductHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const subtotal = lines.reduce((s, l) => s + (num(l.unitPrice) || 0) * l.quantity, 0);
  const total = Math.max(subtotal - (num(f.discountTotal) || 0) + (num(f.shippingTotal) || 0), 0);

  function doSearch(v: string) {
    setSearch(v);
    start(async () => setHits(v.trim().length >= 2 ? await searchProductsForOrderAction(v) : []));
  }
  function add(p: OrderProductHit, variantId: string | null, variantName: string | null, price: number) {
    setLines((ls) => [...ls, { key: `${p.id}:${variantId ?? ""}:${ls.length}`, productId: p.id, variantId, name: variantName ? `${p.name} — ${variantName}` : p.name, quantity: 1, unitPrice: String(price), unitCost: "", catalogCost: p.costPrice }]);
    setSearch(""); setHits([]);
  }
  function addCustomCombo(p: OrderProductHit) {
    start(async () => {
      const picker = await getComboPickerAction(p.id);
      if (!picker || picker.mode !== "CUSTOMIZABLE") { setError("Could not load this combo's choices."); return; }
      setLines((ls) => [...ls, { key: `${p.id}:custom:${ls.length}`, productId: p.id, variantId: null, name: `${p.name} (customized)`, quantity: 1, unitPrice: String(p.price), unitCost: "", catalogCost: null, picker, picks: {} }]);
      setSearch(""); setHits([]);
    });
  }
  const selectionsOf = (l: Line) => (l.picker ? l.picker.slots.flatMap((s) => s.options.filter((o) => (l.picks?.[o.id] ?? 0) > 0).map((o) => ({ slotId: s.id, optionId: o.id, quantity: l.picks?.[o.id] ?? 0 }))) : undefined);
  function previewPrice(l: Line) {
    start(async () => {
      const r = await previewComboPriceAction(l.productId, selectionsOf(l));
      setLine(l.key, { preview: r.ok ? `Server price for this selection: ${formatPrice(r.unitPrice)} (the price above is what you charge)` : r.message });
    });
  }
  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function submit() {
    setError(null);
    start(async () => {
      const payload = {
        channelId: f.channelId, externalOrderRef: f.externalOrderRef, externalPlacedAt: f.externalPlacedAt || null,
        customer: { fullName: f.fullName, phone: f.phone, email: f.email, line1: f.line1, city: f.city || undefined },
        items: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity, unitPrice: num(l.unitPrice), unitCost: l.unitCost.trim() === "" ? null : num(l.unitCost), ...(l.picker ? { selections: selectionsOf(l) } : {}) })),
        shippingTotal: num(f.shippingTotal), discountTotal: num(f.discountTotal), status: f.status, paymentStatus: f.paymentStatus,
        fulfillmentMode: f.fulfillmentMode, stockPolicy: f.stockPolicy, note: f.note || undefined,
        advanceReceived: num(f.advanceReceived), advanceMethod: f.advanceMethod, advanceReference: f.advanceReference,
        settlementReceived: num(f.settlementReceived), settlementReceivedOn: f.settlementReceivedOn || null, settlementReference: f.settlementReference,
        costLines: costs.filter((c) => c.amount.trim() !== "").map((c) => ({ kind: c.kind, amount: num(c.amount) })),
      };
      const r = await createExternalOrderAction(payload);
      if (!r.success) { setError(r.message); toast.error(r.message); return; }
      toast.success(`Recorded as ${r.orderNumber}`);
      router.push(`/admin/orders/${r.id}`);
    });
  }

  return (
    <div className="space-y-8">
      <section className="grid gap-4 rounded-xl border border-border/70 bg-card p-5 sm:grid-cols-3">
        <label className={label}>Channel
          <select className={sel} value={f.channelId} onChange={(e) => setF({ ...f, channelId: e.target.value })}>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className={label}>Marketplace order number *<Input value={f.externalOrderRef} onChange={(e) => setF({ ...f, externalOrderRef: e.target.value })} maxLength={80} /></label>
        <label className={label}>Order date<Input type="date" value={f.externalPlacedAt} onChange={(e) => setF({ ...f, externalPlacedAt: e.target.value })} /></label>
        <label className={label}>Customer name *<Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} maxLength={100} /></label>
        <label className={label}>Phone *<Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={20} /></label>
        <label className={label}>Email (optional)<Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className={`${label} sm:col-span-2`}>Address *<Input value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} maxLength={300} /></label>
        <label className={label}>City / district<Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} maxLength={80} /></label>
      </section>

      <section className="space-y-3 rounded-xl border border-border/70 bg-card p-5">
        <h2 className="font-heading text-lg">Items</h2>
        <p className="text-xs text-muted-foreground">Enter the price the customer actually paid on the marketplace. Unit cost is optional: if left empty the product&apos;s catalogue cost is used, and if there is none the cost stays unknown (it is never guessed).</p>
        {lines.map((l) => (
          <div key={l.key} className="space-y-2">
          <div className="grid items-end gap-2 sm:grid-cols-[1fr_90px_130px_130px_auto]">
            <p className="text-sm font-medium">{l.name}</p>
            <label className={label}>Qty<Input type="number" min={1} max={9999} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} /></label>
            <label className={label}>Unit price<Input type="number" min={0} step="0.01" value={l.unitPrice} onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} /></label>
            <label className={label}>Unit cost{l.catalogCost !== null ? ` (cat. ${l.catalogCost})` : ""}<Input type="number" min={0} step="0.01" value={l.unitCost} onChange={(e) => setLine(l.key, { unitCost: e.target.value })} /></label>
            <button type="button" aria-label={`Remove ${l.name}`} className="mb-2" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 className="size-4 text-destructive" /></button>
          </div>
          {l.picker && (
            <div className="space-y-2 rounded-lg border border-border/70 p-3 text-sm">
              {l.picker.slots.map((s) => (
                <fieldset key={s.id} className="space-y-1">
                  <legend className="font-medium">{s.label} <span className="text-xs text-muted-foreground">(choose {s.minSelect}–{s.maxSelect}, max {s.maxPerOption} each)</span></legend>
                  {s.options.map((o) => (
                    <label key={o.id} className="flex items-center justify-between gap-3">
                      <span>{o.name}{o.variantName ? ` — ${o.variantName}` : ""}</span>
                      <Input className="h-8 w-20" type="number" min={0} max={s.maxPerOption} value={l.picks?.[o.id] ?? 0} onChange={(e) => setLine(l.key, { picks: { ...l.picks, [o.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }, preview: undefined })} />
                    </label>
                  ))}
                </fieldset>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => previewPrice(l)} disabled={pending}>Check selection &amp; price</Button>
              {l.preview && <p className="text-xs text-muted-foreground">{l.preview}</p>}
            </div>
          )}
          </div>
        ))}
        <div className="relative max-w-md">
          <Input placeholder="Search products to add…" value={search} onChange={(e) => doSearch(e.target.value)} />
          {hits.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-popover shadow-md">
              {hits.flatMap((p) => {
                if (p.customizable) return [<button key={p.id} type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary" onClick={() => addCustomCombo(p)}>{p.name} · customizable combo (choose items)</button>];
                if (p.variants.length > 0) return p.variants.map((v) => <button key={`${p.id}:${v.id}`} type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary" onClick={() => add(p, v.id, v.name, v.price)}>{p.name} — {v.name} ({formatPrice(v.price)})</button>);
                return [<button key={p.id} type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary" onClick={() => add(p, null, null, p.price)}>{p.name} ({formatPrice(p.price)}){p.kind === "COMBO" ? " · combo" : ""}</button>];
              })}
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-4 rounded-xl border border-border/70 bg-card p-5 sm:grid-cols-4">
        <label className={label}>Shipping charged<Input type="number" min={0} step="0.01" value={f.shippingTotal} onChange={(e) => setF({ ...f, shippingTotal: e.target.value })} /></label>
        <label className={label}>Discount<Input type="number" min={0} step="0.01" value={f.discountTotal} onChange={(e) => setF({ ...f, discountTotal: e.target.value })} /></label>
        <label className={label}>Order status
          <select className={sel} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"].map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <label className={label}>Payment
          <select className={sel} value={f.paymentStatus} onChange={(e) => setF({ ...f, paymentStatus: e.target.value })}><option value="PAID">Customer paid on the marketplace (label only)</option><option value="UNPAID">Unpaid / cash on delivery</option></select>
        </label>
        <label className={label}>Advance already received (BDT)
          <input className={sel} type="number" min={0} step="0.01" value={f.advanceReceived} onChange={(e) => setF({ ...f, advanceReceived: e.target.value })} />
        </label>
        {num(f.advanceReceived) > 0 && (
          <>
            <label className={label}>Advance paid via
              <select className={sel} value={f.advanceMethod} onChange={(e) => setF({ ...f, advanceMethod: e.target.value })}><option value="COD">Cash / other</option><option value="BKASH">bKash</option><option value="NAGAD">Nagad</option></select>
            </label>
            {f.advanceMethod !== "COD" && <label className={label}>Wallet transaction id<input className={sel} value={f.advanceReference} maxLength={60} onChange={(e) => setF({ ...f, advanceReference: e.target.value })} /></label>}
          </>
        )}
        {channels.find((c) => c.id === f.channelId)?.kind === "MARKETPLACE" && (
          <>
            <p className="text-xs text-muted-foreground sm:col-span-4">
              Expected payout = order total − advance paid to us − commission/payment fee entered below. Enter 0 as the commission if there is none, otherwise profit stays an estimate.
              Expected now: <strong>{formatPrice(Math.max(total - num(f.advanceReceived) - costs.filter((c) => c.kind === "MARKETPLACE_COMMISSION" || c.kind === "PAYMENT_FEE").reduce((a, c) => a + num(c.amount), 0), 0))}</strong>
            </p>
            <label className={label}>Payout received so far (BDT)
              <input className={sel} type="number" min={0} step="0.01" value={f.settlementReceived} onChange={(e) => setF({ ...f, settlementReceived: e.target.value })} />
            </label>
            {num(f.settlementReceived) > 0 && (
              <>
                <label className={label}>Payout received on<input className={sel} type="date" value={f.settlementReceivedOn} onChange={(e) => setF({ ...f, settlementReceivedOn: e.target.value })} /></label>
                <label className={label}>Payout reference<input className={sel} value={f.settlementReference} maxLength={80} onChange={(e) => setF({ ...f, settlementReference: e.target.value })} /></label>
              </>
            )}
          </>
        )}
        <label className={label}>Fulfilment
          <select className={sel} value={f.fulfillmentMode} onChange={(e) => setF({ ...f, fulfillmentMode: e.target.value })}><option value="SELF_SHIP">We ship it</option><option value="MARKETPLACE_FULFILLED">Marketplace ships it</option></select>
        </label>
        <label className={`${label} sm:col-span-2`}>Stock
          <select className={sel} value={f.stockPolicy} onChange={(e) => setF({ ...f, stockPolicy: e.target.value })}><option value="DEDUCT">Deduct from our stock now</option><option value="NONE">Do not deduct (already adjusted / held by marketplace)</option></select>
        </label>
        <p className="self-end text-sm">Order total: <span className="font-semibold">{formatPrice(total)}</span></p>
        <label className={`${label} sm:col-span-4`}>Note<Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={1000} /></label>
      </section>

      <section className="space-y-3 rounded-xl border border-border/70 bg-card p-5">
        <h2 className="font-heading text-lg">Costs you know (optional)</h2>
        <p className="text-xs text-muted-foreground">Only enter amounts you actually have — a commission or fee you leave out is reported as &ldquo;not recorded&rdquo;, never as zero or an estimate.</p>
        {costs.map((c, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <select className={sel} value={c.kind} onChange={(e) => setCosts((cs) => cs.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>{COST_KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
            <Input className="w-40" type="number" min={0} step="0.01" placeholder="Amount" value={c.amount} onChange={(e) => setCosts((cs) => cs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            <button type="button" aria-label="Remove cost" onClick={() => setCosts((cs) => cs.filter((_, j) => j !== i))}><Trash2 className="size-4 text-destructive" /></button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => setCosts((cs) => [...cs, { kind: "MARKETPLACE_COMMISSION", amount: "" }])}>Add a cost</Button>
      </section>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button onClick={submit} disabled={pending || lines.length === 0}>{pending ? "Recording…" : "Record order"}</Button>
    </div>
  );
}
