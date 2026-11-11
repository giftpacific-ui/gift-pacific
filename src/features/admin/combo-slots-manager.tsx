"use client";

import { useState, useTransition } from "react";
import { useReportDirty } from "@/features/admin/product-editor-dirty";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  addComboOptionAction,
  deleteComboOptionAction,
  deleteComboSlotAction,
  saveComboSlotAction,
} from "@/server/actions/admin-combo.actions";
import { searchProductsForBundleAction } from "@/server/actions/admin-product.actions";
import { formatPrice } from "@/lib/utils";

export type ComboSlotView = {
  id: string;
  label: string;
  helpText: string | null;
  minSelect: number;
  maxSelect: number;
  maxPerOption: number;
  sortOrder: number;
  source: "MANUAL" | "CATALOG" | "BOXES";
  categoryId: string | null;
  options: {
    id: string;
    productId: string;
    productName: string;
    productStatus: string;
    variantId: string | null;
    variantName: string | null;
    priceDelta: number;
  }[];
};

type SearchResult = { id: string; name: string; price: number; isVariantProduct: boolean; variants: { id: string; name: string }[] };

type CategoryOpt = { id: string; name: string; depth: number };
const SOURCE_HELP = {
  MANUAL: "You choose exactly which products customers can pick.",
  CATALOG: "Customers can pick ANY active single product (optionally limited to one category). Prices are always the current product prices.",
  BOXES: "Customers can pick any active box. Fixed-price combos add the box price; sum-of-prices combos use the box price.",
} as const;

function SlotCard({ comboId, slot, categories }: { comboId: string; slot: ComboSlotView; categories: CategoryOpt[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState({
    label: slot.label,
    helpText: slot.helpText ?? "",
    minSelect: slot.minSelect,
    maxSelect: slot.maxSelect,
    maxPerOption: slot.maxPerOption,
    source: slot.source,
    categoryId: slot.categoryId ?? "",
  });
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [surcharge, setSurcharge] = useState(0);
  const savedForm = {
    label: slot.label,
    helpText: slot.helpText ?? "",
    minSelect: slot.minSelect,
    maxSelect: slot.maxSelect,
    maxPerOption: slot.maxPerOption,
    source: slot.source,
    categoryId: slot.categoryId ?? "",
  };
  useReportDirty(`combo-slot:${slot.id}`, JSON.stringify(form) !== JSON.stringify(savedForm) || isPending);

  const run = (fn: () => Promise<{ success: boolean; message?: string }>, ok?: string) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.success) toast.error(r.message ?? "Something went wrong.");
      else if (ok) toast.success(ok);
      router.refresh();
    });

  function doSearch(value: string) {
    setSearch(value);
    startTransition(async () => {
      setResults(value.trim() ? await searchProductsForBundleAction(value.trim(), comboId) : []);
    });
  }
  const add = (productId: string, variantId: string | null) =>
    run(async () => {
      const r = await addComboOptionAction(comboId, slot.id, productId, variantId, surcharge);
      setSearch("");
      setResults([]);
      return r;
    });

  const num = (key: "minSelect" | "maxSelect" | "maxPerOption", label: string) => (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <Input type="number" min={key === "minSelect" ? 0 : 1} value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} />
    </label>
  );

  return (
    <div className="space-y-3 rounded-xl border border-border/70 p-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-4">
          Group name (e.g. “Choose your box”)
          <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-4">
          Help text (optional)
          <Input value={form.helpText} onChange={(e) => setForm({ ...form, helpText: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
          Where do the choices come from?
          <select className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as ComboSlotView["source"], categoryId: "" })}>
            <option value="MANUAL">Products I pick</option>
            <option value="CATALOG">Any active product (free choice)</option>
            <option value="BOXES">Our boxes</option>
          </select>
          <span>{SOURCE_HELP[form.source]}</span>
        </label>
        {form.source === "CATALOG" && (
          <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2">
            Limit to category (optional)
            <select className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{`${"— ".repeat(c.depth)}${c.name}`}</option>)}
            </select>
          </label>
        )}
        {num("minSelect", "Minimum (0 = optional)")}
        {num("maxSelect", "Maximum")}
        {num("maxPerOption", "Max of one item")}
        <div className="flex items-end gap-2">
          <Button type="button" size="sm" disabled={isPending} onClick={() => run(() => saveComboSlotAction(comboId, slot.id, form), "Saved")}>
            Save group
          </Button>
          <button type="button" aria-label="Delete group" disabled={isPending} onClick={() => run(() => deleteComboSlotAction(comboId, slot.id))}>
            <Trash2 className="size-4 text-destructive" />
          </button>
        </div>
      </div>

      {form.source !== "MANUAL" ? (
        <p className="rounded-lg bg-secondary/50 px-3 py-2 text-sm text-muted-foreground">{SOURCE_HELP[form.source]} Use “Maximum” for the total allowed and “Max of one item” for the per-product quantity limit.</p>
      ) : (
        <>
      <ul className="space-y-1.5">
        {slot.options.length === 0 && <li className="text-sm text-muted-foreground">No products yet — add at least one.</li>}
        {slot.options.map((o) => (
          <li key={o.id} className="flex items-center justify-between rounded-lg bg-secondary/50 px-3 py-2 text-sm">
            <span>
              {o.productName}
              {o.variantName ? ` — ${o.variantName}` : ""}
              {o.priceDelta > 0 && <span className="text-muted-foreground"> (+{formatPrice(o.priceDelta)})</span>}
              {o.productStatus !== "ACTIVE" && <span className="ml-2 text-destructive">inactive — customers cannot choose this</span>}
            </span>
            <button type="button" aria-label="Remove product" disabled={isPending} onClick={() => run(() => deleteComboOptionAction(comboId, slot.id, o.id))}>
              <Trash2 className="size-4 text-destructive" />
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-start gap-3">
        <div className="relative w-full max-w-sm">
          <Input placeholder="Search products to allow in this group…" value={search} onChange={(e) => doSearch(e.target.value)} />
          {results.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-popover shadow-md">
              {results.flatMap((p) =>
                p.isVariantProduct
                  ? p.variants.map((v) => (
                      <button key={`${p.id}:${v.id}`} type="button" disabled={isPending} onClick={() => add(p.id, v.id)} className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary">
                        {p.name} — {v.name}
                      </button>
                    ))
                  : [
                      <button key={p.id} type="button" disabled={isPending} onClick={() => add(p.id, null)} className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary">
                        {p.name} — {formatPrice(p.price)}
                      </button>,
                    ],
              )}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Surcharge
          <Input type="number" min={0} value={surcharge} onChange={(e) => setSurcharge(Math.max(0, Number(e.target.value) || 0))} className="w-24" />
        </label>
      </div>
        </>
      )}
    </div>
  );
}

export function ComboSlotsManager({ comboId, slots, categories = [] }: { comboId: string; slots: ComboSlotView[]; categories?: CategoryOpt[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);

  function addSlot() {
    startTransition(async () => {
      const r = await saveComboSlotAction(comboId, null, { label: `Group ${slots.length + 1}`, minSelect: 1, maxSelect: 1, maxPerOption: 1, sortOrder: slots.length });
      if (!r.success) toast.error(r.message);
      setCreating(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Customers pick products for each group. Every choice, limit and price is validated on the server; groups whose
        minimum is 1 or more are required.
      </p>
      {slots.map((slot) => (
        <SlotCard key={slot.id} comboId={comboId} slot={slot} categories={categories} />
      ))}
      <Button type="button" variant="outline" disabled={isPending || creating} onClick={() => { setCreating(true); addSlot(); }}>
        Add selection group
      </Button>
    </div>
  );
}
