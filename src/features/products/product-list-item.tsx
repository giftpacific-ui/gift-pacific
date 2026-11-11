import Image from "next/image";
import Link from "next/link";
import type { PublicProductCard } from "@/lib/product-dto";
import { Badge } from "@/components/ui/badge";
import { formatPrice } from "@/lib/utils";
import { WishlistButton } from "@/features/wishlist/wishlist-button";
import { CardAddToCartButton } from "@/features/products/card-add-to-cart-button";
import { QuickViewButton } from "@/features/products/quick-view-button";
import { Button } from "@/components/ui/button";

const badgeLabels: Record<string, string> = {
  NEW: "New",
  BEST_SELLER: "Best Seller",
  LIMITED_EDITION: "Limited Edition",
  HANDMADE: "Handmade",
  PERSONALIZED: "Personalized",
  SALE: "Sale",
};

export function ProductListItem({ product }: { product: PublicProductCard }) {
  const image = product.images[0]?.url;
  const displayPrice = product.price;
  const isOnSale = product.compareAtPrice !== null;
  const href = `/products/${product.slug}`;
  const outOfStock = !product.availability.inStock;

  return (
    <div className="flex gap-4 rounded-[4px] border border-border bg-card p-4 sm:gap-6">
      <Link href={href} className="relative size-28 shrink-0 overflow-hidden rounded-[3px] bg-secondary sm:size-36">
        {image && (
          <Image src={image} alt={product.name} fill sizes="150px" className="product-image-tone object-cover" />
        )}
      </Link>

      <div className="flex flex-1 flex-col justify-between">
        <div>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              {product.category && (
                <p className="text-xs tracking-wide text-muted-foreground">
                  {product.category.name}
                </p>
              )}
              <Link href={href}>
                <h3 className="font-heading text-lg font-semibold transition-colors hover:text-primary sm:text-xl">{product.name}</h3>
              </Link>
            </div>
            <WishlistButton productId={product.id} />
          </div>
          {product.shortDescription && (
            <p className="mt-1 hidden max-w-md text-sm text-muted-foreground sm:block">
              {product.shortDescription}
            </p>
          )}
          {(outOfStock || product.badges.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {outOfStock ? (
                <Badge variant="secondary">Out of stock</Badge>
              ) : (
                product.badges.slice(0, 3).map((badge) => (
                  <Badge key={badge} variant={badge === "SALE" ? "destructive" : "secondary"}>
                    {badgeLabels[badge] ?? badge}
                  </Badge>
                ))
              )}
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold">{formatPrice(displayPrice)}</span>
            {isOnSale && (
              <span className="text-xs text-muted-foreground line-through">
                {formatPrice(product.compareAtPrice!)}
              </span>
            )}
          </div>
          <div className="w-36">
            {outOfStock ? (
              <Button type="button" variant="secondary" size="sm" disabled className="w-full">
                Out of stock
              </Button>
            ) : product.type === "STANDARD" ? (
              <CardAddToCartButton
                productId={product.id}
                name={product.name}
                price={displayPrice}
                currency={product.currency}
              />
            ) : (
              <QuickViewButton productId={product.id} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
