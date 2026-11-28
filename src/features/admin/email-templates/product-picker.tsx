"use client";

/* eslint-disable @next/next/no-img-element */
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchTemplateProductsAction } from "@/server/actions/admin-email-template.actions";
import type { PickerProduct } from "@/server/services/email-template-designer.service";

/** Product card as it will be understood by the admin: name, image, current price, original price (only if the shop has one) and the product URL. */
export function ProductSummary({ product }: { product: PickerProduct | null | undefined }) {
  if (!product) return <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No product chosen yet.</p>;
  return (
    <div className="flex gap-3 rounded-md border p-3">
      {product.imageUrl ? <img src={product.imageUrl} alt="" className="size-16 shrink-0 rounded object-cover" /> : <div className="size-16 shrink-0 rounded bg-muted" aria-hidden />}
      <div className="min-w-0 text-sm">
        <div className="truncate font-medium">{product.name}</div>
        <div>
          <span className="font-semibold">{product.priceLabel}</span>
          {product.compareAtLabel && <span className="ml-2 text-muted-foreground line-through">{product.compareAtLabel}</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{product.url}</div>
      </div>
    </div>
  );
}

/** Search-based selector over existing active products. Prices and URLs shown here come from the server; the e-mail is built from the product ID only. */
export function ProductPicker({ value, product, onPick }: { value: string; product: PickerProduct | null | undefined; onPick: (p: PickerProduct) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickerProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function search(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await searchTemplateProductsAction(q);
      if (res.success) setResults(res.products); else { setResults(null); setError(res.message); }
    });
  }

  return (
    <div className="space-y-2">
      <ProductSummary product={value ? product : null} />
      {value && product === null && <p role="alert" className="text-sm text-destructive">This product is no longer available. Choose another one.</p>}
      <div className="flex gap-2">
        <Input value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} placeholder="Search products by name or SKU" aria-label="Search products"
          onKeyDown={(e) => { if (e.key === "Enter") search(e as unknown as React.FormEvent); }} />
        <Button type="button" variant="outline" onClick={search} disabled={pending}><Search /> {pending ? "…" : "Search"}</Button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {results && results.length === 0 && <p className="text-sm text-muted-foreground">No active products found.</p>}
      {results && results.length > 0 && (
        <ul className="max-h-60 space-y-1 overflow-y-auto">
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => { onPick(p); setResults(null); setQ(""); }} className="w-full rounded-md border p-2 text-left hover:bg-secondary">
                <ProductSummary product={p} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
