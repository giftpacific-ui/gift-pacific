import Image from "next/image";
import Link from "next/link";
import { Play } from "lucide-react";
import type { PublicProductCard } from "@/lib/product-dto";
import { formatPrice } from "@/lib/utils";
import { WishlistButton } from "@/features/wishlist/wishlist-button";
import { CardAddToCartButton } from "@/features/products/card-add-to-cart-button";
import { QuickViewButton } from "@/features/products/quick-view-button";
import { CardHoverVideo } from "@/features/products/card-hover-video";
import { Button } from "@/components/ui/button";
import { getYouTubeCardEmbedUrl } from "@/utils/GetYoutubeUrl";

const badgeLabels: Record<string, string> = {
  NEW: "New",
  BEST_SELLER: "Best seller",
  LIMITED_EDITION: "Limited edition",
  HANDMADE: "Handmade",
  PERSONALIZED: "Personalized",
  SALE: "Sale",
};

const SIZES = "(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw";

/**
 * Editorial product card: 4:5 photograph, optional index rule, restrained
 * badges, second photograph crossfades in on hover, quick action rises from the
 * bottom (always visible on touch devices). `index` (zero-based) adds the
 * "01 — Category" rule used in the staggered homepage / shop grids.
 */
export function ProductCard({ product, index, priority = false }: { product: PublicProductCard; index?: number; priority?: boolean }) {
  const image = product.images[0]?.url;
  const hoverImage = product.images[1]?.url;
  const videoEmbedUrl = getYouTubeCardEmbedUrl(product.videoUrl);

  // `price` is already the display price (for VARIANT products: the lowest
  // purchasable variant), and `compareAtPrice` is only set when on sale.
  const displayPrice = product.price;
  const isOnSale = product.compareAtPrice !== null;
  const discountPercent = isOnSale ? Math.round((1 - displayPrice / product.compareAtPrice!) * 100) : 0;
  const href = `/products/${product.slug}`;

  // Availability is computed server-side for EVERY product type — variant
  // products use their variants' stock, never the product-level stock.
  const outOfStock = !product.availability.inStock;
  const tags = product.badges.filter((b) => b !== "SALE").slice(0, 2);

  return (
    <article className="group relative flex flex-col">
      {index !== undefined && (
        <div className="mb-3 flex items-baseline justify-between border-b border-border pb-2 text-xs text-muted-foreground" aria-hidden>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <span>{product.category?.name}</span>
        </div>
      )}

      <div className="relative aspect-4/5 overflow-hidden rounded-[3px] bg-secondary">
        <Link href={href} className="absolute inset-0 z-0" aria-label={product.name}>
          {image ? (
            <Image
              src={image}
              alt={product.images[0]?.altText || product.name}
              fill
              priority={priority}
              sizes={SIZES}
              className={`product-image-tone object-cover transition-[transform,opacity] duration-700 ease-out group-hover:scale-[1.04] ${
                hoverImage && !outOfStock ? "group-hover:opacity-0" : ""
              } ${outOfStock ? "opacity-70 grayscale-40" : ""}`}
            />
          ) : (
            <span className="grid h-full place-items-center px-4 text-center font-heading text-lg text-muted-foreground">{product.name}</span>
          )}

          {!outOfStock && videoEmbedUrl ? (
            <CardHoverVideo embedUrl={videoEmbedUrl} title={product.name} />
          ) : (
            hoverImage &&
            !outOfStock && (
              <Image
                src={hoverImage}
                alt=""
                fill
                sizes={SIZES}
                className="product-image-tone object-cover opacity-0 transition-opacity duration-500 group-hover:opacity-100"
              />
            )
          )}
        </Link>

        {!outOfStock && videoEmbedUrl && (
          <div aria-hidden className="pointer-events-none absolute right-2.5 bottom-14 z-10 grid size-7 place-items-center rounded-full bg-black/60 text-white backdrop-blur-md transition-opacity group-hover:opacity-0 lg:bottom-2.5">
            <Play className="ml-0.5 size-3.5 fill-current" />
          </div>
        )}

        <div className="pointer-events-none absolute top-2.5 left-2.5 z-10 flex flex-col items-start gap-1.5 sm:top-3 sm:left-3">
          {outOfStock ? (
            <span className="rounded-[2px] bg-foreground px-2 py-0.5 text-[0.7rem] font-semibold tracking-wide text-background">Out of stock</span>
          ) : (
            <>
              {discountPercent > 0 && (
                <span className="rounded-[2px] bg-background px-2 py-0.5 text-[0.72rem] font-bold text-primary">−{discountPercent}%</span>
              )}
              {tags.map((badge) => (
                <span key={badge} className="rounded-[2px] bg-foreground px-2 py-0.5 text-[0.7rem] font-semibold tracking-wide text-background">
                  {badgeLabels[badge] ?? badge}
                </span>
              ))}
            </>
          )}
        </div>

        <div className="absolute top-2.5 right-2.5 z-10 sm:top-3 sm:right-3 lg:translate-y-[-6px] lg:opacity-0 lg:transition-all lg:duration-300 lg:group-focus-within:translate-y-0 lg:group-focus-within:opacity-100 lg:group-hover:translate-y-0 lg:group-hover:opacity-100">
          <WishlistButton productId={product.id} />
        </div>

        <div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 z-10 sm:inset-x-3 sm:bottom-3 lg:translate-y-[130%] lg:transition-transform lg:duration-300 lg:group-focus-within:translate-y-0 lg:group-hover:translate-y-0">
          <div className="pointer-events-auto">
            {outOfStock ? (
              <Button type="button" variant="secondary" size="sm" disabled className="w-full shadow-sm">
                Out of stock
              </Button>
            ) : product.type === "STANDARD" ? (
              <CardAddToCartButton productId={product.id} name={product.name} price={displayPrice} currency={product.currency} />
            ) : (
              <QuickViewButton productId={product.id} />
            )}
          </div>
        </div>
      </div>

      <Link href={href} className="mt-3.5 space-y-1 focus-visible:outline-offset-4">
        <h3 className="line-clamp-2 font-heading text-[1.15rem] leading-snug font-semibold transition-colors group-hover:text-primary">{product.name}</h3>
        <p className="flex items-baseline gap-2.5">
          <span className="font-semibold">{formatPrice(displayPrice)}</span>
          {isOnSale && (
            <span className="text-sm text-muted-foreground">
              <span className="sr-only">Was </span>
              <s>{formatPrice(product.compareAtPrice!)}</s>
            </span>
          )}
        </p>
      </Link>
    </article>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="aspect-4/5 animate-pulse rounded-[3px] bg-secondary" />
      <div className="h-5 w-3/4 animate-pulse rounded-sm bg-secondary" />
      <div className="h-4 w-1/3 animate-pulse rounded-sm bg-secondary" />
    </div>
  );
}
