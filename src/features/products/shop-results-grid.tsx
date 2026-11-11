"use client";

import type { PublicProductCard } from "@/lib/product-dto";
import { ProductCard } from "@/features/products/product-card";
import { ProductListItem } from "@/features/products/product-list-item";
import { useShopViewMode } from "@/features/products/use-shop-view-mode";

export function ShopResultsGrid({ items }: { items: PublicProductCard[] }) {
  const [viewMode] = useShopViewMode();

  if (viewMode === "list") {
    return (
      <div className="space-y-5">
        {items.map((product) => (
          <ProductListItem key={product.id} product={product} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 sm:gap-x-6 lg:gap-y-12 xl:grid-cols-4">
      {items.map((product, i) => (
        <ProductCard key={product.id} product={product} priority={i < 4} />
      ))}
    </div>
  );
}
