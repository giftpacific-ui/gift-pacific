"use client";

import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";

type CategoryNode = {
  id: string;
  name: string;
  slug: string;
  children: CategoryNode[];
};

const badgeOptions: { value: "NEW" | "BEST_SELLER"; label: string }[] = [
  { value: "NEW", label: "New" },
  { value: "BEST_SELLER", label: "Best Seller" },
];

function CategoryTreeLinks({
  nodes,
  activeSlug,
  depth = 0,
}: {
  nodes: CategoryNode[];
  activeSlug?: string;
  depth?: number;
}) {
  return (
    <ul className={cn("space-y-1", depth > 0 && "ml-3.5 border-l border-border/70 pl-3")}>
      {nodes.map((node) => (
        <li key={node.id}>
          <Link
            href={`/shop/${node.slug}`}
            className={cn(
              "block rounded-[3px] px-2 py-1 text-sm",
              node.slug === activeSlug
                ? "bg-primary text-primary-foreground"
                : "text-foreground/80 hover:bg-secondary",
            )}
          >
            {node.name}
          </Link>
          {node.children.length > 0 && (
            <CategoryTreeLinks nodes={node.children} activeSlug={activeSlug} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function ShopFilterSidebar({
  categoryTree,
  activeCategorySlug,
}: {
  categoryTree: CategoryNode[];
  activeCategorySlug?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [minPrice, setMinPrice] = useState(searchParams.get("minPrice") ?? "");
  const [maxPrice, setMaxPrice] = useState(searchParams.get("maxPrice") ?? "");

  const activeBadges = (searchParams.get("badges") ?? "").split(",").filter(Boolean);
  const inStockOnly = searchParams.get("inStock") === "true";
  const isFeatured = searchParams.get("featured") === "true";

  function updateParams(updates: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    }
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  function toggleBadge(value: string) {
    const next = activeBadges.includes(value)
      ? activeBadges.filter((b) => b !== value)
      : [...activeBadges, value];
    updateParams({ badges: next.length > 0 ? next.join(",") : undefined });
  }

  function applyPriceRange() {
    updateParams({
      minPrice: minPrice || undefined,
      maxPrice: maxPrice || undefined,
    });
  }

  const hasActiveFilters =
    activeBadges.length > 0 || inStockOnly || isFeatured || searchParams.get("minPrice") || searchParams.get("maxPrice");

  function clearFilters() {
    setMinPrice("");
    setMaxPrice("");
    router.push(pathname);
  }

  return (
    <aside aria-label="Filters" className="w-full shrink-0 space-y-8 lg:w-56">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-lg font-semibold">Category</h2>
        </div>
        <Link
          href="/shop"
          className={cn(
            "mb-1 block rounded-[3px] px-2 py-1 text-sm",
            !activeCategorySlug
              ? "bg-primary text-primary-foreground"
              : "text-foreground/80 hover:bg-secondary",
          )}
        >
          All products
        </Link>
        <CategoryTreeLinks nodes={categoryTree} activeSlug={activeCategorySlug} />
      </div>

      <div>
        <h2 className="mb-3 font-heading text-lg font-semibold">Price range</h2>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            placeholder="Min"
            aria-label="Minimum price"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            onBlur={applyPriceRange}
            className="h-9 px-2 text-sm"
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="number"
            inputMode="numeric"
            placeholder="Max"
            aria-label="Maximum price"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            onBlur={applyPriceRange}
            className="h-9 px-2 text-sm"
          />
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-heading text-lg font-semibold">Availability</h2>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={inStockOnly}
            onCheckedChange={(checked) => updateParams({ inStock: checked ? "true" : undefined })}
          />
          In stock only
        </label>
      </div>

      <div>
        <h2 className="mb-3 font-heading text-lg font-semibold">Highlights</h2>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={isFeatured}
              onCheckedChange={(checked) => updateParams({ featured: checked ? "true" : undefined })}
            />
            Featured
          </label>
          {badgeOptions.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={activeBadges.includes(option.value)}
                onCheckedChange={() => toggleBadge(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>

      {hasActiveFilters && (
        <Button type="button" variant="outline" size="sm" onClick={clearFilters} className="gap-1.5">
          <X className="size-3.5" />
          Clear filters
        </Button>
      )}
    </aside>
  );
}
