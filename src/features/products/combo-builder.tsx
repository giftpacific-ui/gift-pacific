"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Minus, Plus } from "lucide-react";
import type { PublicProductDetail } from "@/lib/product-dto";
import { Button } from "@/components/ui/button";
import { useAddToCart } from "@/features/cart/use-cart";
import { useCartUiStore } from "@/features/cart/cart-ui-store";
import { formatPrice } from "@/lib/utils";
import { MAX_QUANTITY_PER_LINE } from "@/lib/stock";

/**
 * Build-your-own combo. Everything shown here is display data: the server re-validates every
 * choice, limit and availability and decides the price (the figure below is an estimate).
 */
export function ComboBuilder({ product }: { product: PublicProductDetail }) {
  const combo = product.combo!;
  const addToCart = useAddToCart();
  const openCart = useCartUiStore((s) => s.open);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [quantity, setQuantity] = useState(1);
  // Large catalog groups: search + "show more" so the list stays usable. Chosen items are pinned to the top.
  const [search, setSearch] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, number>>({});
  const PAGE = 24;
  function visibleOptions(slot: (typeof combo.slots)[number]) {
    const q = (search[slot.id] ?? "").trim().toLowerCase();
    const matches = slot.options.filter((o) => !q || `${o.name} ${o.variantName ?? ""}`.toLowerCase().includes(q));
    const chosen = matches.filter((o) => (picks[o.id] ?? 0) > 0);
    const rest = matches.filter((o) => (picks[o.id] ?? 0) === 0);
    const all = [...chosen, ...rest];
    const limit = shown[slot.id] ?? PAGE;
    return { items: all.slice(0, Math.max(limit, chosen.length)), total: all.length, hidden: Math.max(0, all.length - Math.max(limit, chosen.length)) };
  }

  const slotTotals = useMemo(
    () => combo.slots.map((slot) => slot.options.reduce((sum, o) => sum + (picks[o.id] ?? 0), 0)),
    [combo.slots, picks],
  );
  const problems = combo.slots
    .map((slot, i) => {
      const total = slotTotals[i];
      if (total < slot.minSelect) return `Choose ${slot.minSelect === 1 ? "an item" : `at least ${slot.minSelect}`} for “${slot.label}”.`;
      return null;
    })
    .filter((p): p is string => p !== null);
  const valid = problems.length === 0 && slotTotals.some((t) => t > 0);

  const estimate = useMemo(() => {
    let sum = 0;
    for (const slot of combo.slots) {
      for (const o of slot.options) {
        const n = picks[o.id] ?? 0;
        if (!n) continue;
        sum += combo.pricing === "COMPONENT_SUM" ? o.price * n : o.priceDelta * n;
      }
    }
    return combo.pricing === "COMPONENT_SUM" ? sum : combo.basePrice + sum;
  }, [combo, picks]);

  function setPick(slotIndex: number, optionId: string, next: number) {
    const slot = combo.slots[slotIndex];
    setPicks((prev) => {
      const draft = { ...prev };
      if (slot.maxSelect === 1 && next > 0) {
        // Single-choice group: picking one replaces the previous pick.
        for (const o of slot.options) delete draft[o.id];
      }
      if (next <= 0) delete draft[optionId];
      else draft[optionId] = next;
      return draft;
    });
  }

  function submit() {
    if (!valid) return;
    const selections = combo.slots.flatMap((slot) =>
      slot.options.filter((o) => (picks[o.id] ?? 0) > 0).map((o) => ({ slotId: slot.id, optionId: o.id, quantity: picks[o.id] })),
    );
    addToCart.mutate(
      { productId: product.id, quantity, selections },
      { onSuccess: (result) => { if (result.success) openCart(); } },
    );
  }

  if (!product.availability.inStock) {
    return <p className="text-sm font-medium text-destructive">Some parts of this combo are sold out right now. Please check back soon.</p>;
  }

  return (
    <div className="space-y-8">
      {combo.slots.map((slot, slotIndex) => {
        const total = slotTotals[slotIndex];
        const full = total >= slot.maxSelect;
        return (
          <fieldset key={slot.id} className="space-y-3">
            <legend className="font-heading text-lg font-semibold">
              {slot.label}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {slot.minSelect >= 1 ? "Required" : "Optional"} · choose {slot.minSelect === slot.maxSelect ? slot.maxSelect : `${slot.minSelect}–${slot.maxSelect}`}
                {slot.maxSelect > 1 ? ` (${total} chosen)` : ""}
              </span>
            </legend>
            {slot.helpText && <p className="text-sm text-muted-foreground">{slot.helpText}</p>}
            {slot.options.length > 12 && (
              <input
                type="search" aria-label={`Search ${slot.label}`} placeholder="Search products…"
                value={search[slot.id] ?? ""} onChange={(e) => setSearch({ ...search, [slot.id]: e.target.value })}
                className="h-10 w-full rounded-[4px] border border-input bg-background px-3 text-sm"
              />
            )}
            {visibleOptions(slot).total === 0 && <p className="text-sm text-muted-foreground">No products match your search.</p>}
            <ul className="grid gap-3 sm:grid-cols-2">
              {visibleOptions(slot).items.map((o) => {
                const n = picks[o.id] ?? 0;
                const cap = Math.min(slot.maxPerOption, o.maxQuantity ?? slot.maxPerOption);
                const canAdd = o.available && n < cap && (!full || slot.maxSelect === 1);
                return (
                  <li key={o.id} className={`flex items-center gap-3 rounded-[4px] border p-3 ${n > 0 ? "border-foreground bg-secondary/40" : "border-border"} ${o.available ? "" : "opacity-50"}`}>
                    {o.image && <Image src={o.image} alt="" width={56} height={56} className="size-14 shrink-0 rounded-[3px] object-cover" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{o.name}{o.variantName ? ` — ${o.variantName}` : ""}</p>
                      <p className="text-xs text-muted-foreground">
                        {!o.available ? "Unavailable" : combo.pricing === "COMPONENT_SUM" ? formatPrice(o.price) : o.priceDelta > 0 ? `+${formatPrice(o.priceDelta)}` : "Included"}
                      </p>
                    </div>
                    {slot.maxSelect === 1 ? (
                      <Button type="button" size="sm" variant={n > 0 ? "default" : "outline"} disabled={!o.available} aria-pressed={n > 0} onClick={() => setPick(slotIndex, o.id, n > 0 ? 0 : 1)}>
                        {n > 0 ? "Selected" : "Choose"}
                      </Button>
                    ) : (
                      <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${o.name}`}>
                        <Button type="button" size="icon" variant="outline" className="size-8" aria-label={`Remove one ${o.name}`} disabled={n === 0} onClick={() => setPick(slotIndex, o.id, n - 1)}>
                          <Minus className="size-3.5" />
                        </Button>
                        <span className="w-6 text-center text-sm tabular-nums" aria-live="polite">{n}</span>
                        <Button type="button" size="icon" variant="outline" className="size-8" aria-label={`Add one ${o.name}`} disabled={!canAdd} onClick={() => setPick(slotIndex, o.id, n + 1)}>
                          <Plus className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {visibleOptions(slot).hidden > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setShown({ ...shown, [slot.id]: (shown[slot.id] ?? PAGE) + PAGE })}>
                Show more ({visibleOptions(slot).hidden} more)
              </Button>
            )}
          </fieldset>
        );
      })}

      <div className="space-y-4 border-t border-border pt-6">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Combos</span>
          <div className="flex items-center gap-1" role="group" aria-label="Number of combos">
            <Button type="button" size="icon" variant="outline" className="size-8" aria-label="Fewer combos" disabled={quantity <= 1} onClick={() => setQuantity((q) => Math.max(1, q - 1))}><Minus className="size-3.5" /></Button>
            <span className="w-8 text-center tabular-nums">{quantity}</span>
            <Button type="button" size="icon" variant="outline" className="size-8" aria-label="More combos" disabled={quantity >= MAX_QUANTITY_PER_LINE} onClick={() => setQuantity((q) => q + 1)}><Plus className="size-3.5" /></Button>
          </div>
        </div>
        <p className="flex items-baseline justify-between" aria-live="polite">
          <span className="text-sm text-muted-foreground">Your combo</span>
          <span className="font-heading text-2xl font-semibold">{formatPrice(estimate * quantity)}</span>
        </p>
        {!valid && problems.length > 0 && <p className="text-sm text-muted-foreground">{problems[0]}</p>}
        <Button type="button" size="lg" className="w-full" disabled={!valid || addToCart.isPending} onClick={submit}>
          {addToCart.isPending ? "Adding…" : "Add to cart"}
        </Button>
        <p className="text-xs text-muted-foreground">The final price and availability are confirmed when you add to your cart.</p>
      </div>
    </div>
  );
}
