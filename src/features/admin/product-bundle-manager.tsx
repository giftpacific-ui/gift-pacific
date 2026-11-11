"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  addBundleItemAction,
  deleteBundleItemAction,
  searchProductsForBundleAction,
} from "@/server/actions/admin-product.actions";
import { formatPrice } from "@/lib/utils";
import type { Product, ProductBundleItem, ProductVariant } from "@prisma/client";
import { toast } from "sonner";

export type BundleItemWithComponent = ProductBundleItem & { component: Product; variant?: ProductVariant | null };

type SearchResult = {
  id: string;
  name: string;
  price: number;
  isVariantProduct: boolean;
  variants: { id: string; name: string }[];
};

export function ProductBundleManager({
  bundleId,
  items,
}: {
  bundleId: string;
  items: BundleItemWithComponent[];
}) {
  const [search, setSearch] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSearch(value: string) {
    setSearch(value);
    startTransition(async () => {
      const found = value.trim() ? await searchProductsForBundleAction(value, bundleId) : [];
      setResults(found);
    });
  }

  function handleAdd(componentId: string, variantId: string | null) {
    startTransition(async () => {
      const result = await addBundleItemAction(bundleId, componentId, quantity, variantId);
      if (!result.success) toast.error(result.message);
      setSearch("");
      setResults([]);
      router.refresh();
    });
  }

  function handleDelete(bundleItemId: string) {
    startTransition(async () => {
      const result = await deleteBundleItemAction(bundleItemId, bundleId);
      if (!result.success) toast.error(result.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between rounded-lg border border-border/70 p-3 text-sm">
              <span>
                {item.quantity}× {item.component.name}
                {item.variant ? ` — ${item.variant.name}` : ""}{" "}
                <span className="text-muted-foreground">
                  ({formatPrice(Number(item.variant?.price ?? item.component.price))} each)
                </span>
              </span>
              <button onClick={() => handleDelete(item.id)} aria-label="Remove from combo">
                <Trash2 className="size-4 text-destructive" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-start gap-3">
        <div className="relative w-full max-w-sm">
          <Input
            placeholder="Search products to add…"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
          />
          {results.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-popover shadow-md">
              {results.flatMap((product) =>
                product.isVariantProduct
                  ? product.variants.map((variant) => (
                      <button
                        key={`${product.id}:${variant.id}`}
                        type="button"
                        onClick={() => handleAdd(product.id, variant.id)}
                        disabled={isPending}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary"
                      >
                        {product.name} — {variant.name}
                      </button>
                    ))
                  : [
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => handleAdd(product.id, null)}
                        disabled={isPending}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary"
                      >
                        {product.name} — {formatPrice(product.price)}
                      </button>,
                    ],
              )}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Quantity
          <Input
            type="number"
            min={1}
            max={99}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
            className="w-20"
          />
        </label>
      </div>
    </div>
  );
}
