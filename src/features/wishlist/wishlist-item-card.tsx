"use client";

import Image from "next/image";
import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toggleWishlistItem } from "@/server/actions/wishlist.actions";
import { useAddToCart } from "@/features/cart/use-cart";
import { formatPrice } from "@/lib/utils";
import type { PublicProductCard } from "@/lib/product-dto";
import { useQueryClient } from "@tanstack/react-query";
import { WISHLIST_QUERY_KEY } from "@/features/wishlist/use-wishlist";
import { useTransition } from "react";
import { useRouter } from "next/navigation";

export function WishlistItemCard({ product, unavailable }: { product?: PublicProductCard; unavailable?: { productId: string; name: string } }) {
  const productId = product?.id ?? unavailable?.productId ?? "";
  const addToCart = useAddToCart();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleRemove() {
    startTransition(async () => {
      await toggleWishlistItem(productId);
      queryClient.invalidateQueries({ queryKey: WISHLIST_QUERY_KEY });
      router.refresh();
    });
  }

  if (!product) {
    return (
      <div className="flex items-center gap-4 rounded-xl border border-dashed border-border/70 p-4 text-sm">
        <div className="flex-1">
          <p className="font-medium text-muted-foreground">{unavailable?.name}</p>
          <p className="text-xs text-muted-foreground">No longer available</p>
        </div>
        <Button size="sm" variant="outline" onClick={handleRemove} disabled={isPending}>Remove</Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 rounded-xl border border-border/70 p-4">
      <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-secondary">
        {product.images[0] && (
          <Image
            src={product.images[0].url}
            alt={product.name}
            fill
            className="object-cover"
          />
        )}
      </div>
      <div className="flex-1">
        <Link
          href={`/products/${product.slug}`}
          className="font-medium hover:underline"
        >
          {product.name}
        </Link>
        <p className="text-sm text-muted-foreground">
          {formatPrice(product.price)}
          <span className="ml-2 text-xs">{product.availability.inStock ? "In stock" : "Out of stock"}</span>
        </p>
      </div>
      {product.availability.inStock ? (
        product.type === "STANDARD" ? (
          <Button
            size="sm"
            onClick={() =>
              // "Move": only after the server accepted the add (stock/price checks passed) is it taken off the wishlist.
              addToCart.mutate(
                { productId: product.id, variantId: null, quantity: 1 },
                { onSuccess: (result) => { if (result.success) handleRemove(); } },
              )
            }
            disabled={addToCart.isPending}
          >
            Move to cart
          </Button>
        ) : (
          // Variant / personalized / bundle products need choices made on
          // the product page — adding them blind would be rejected.
          <Button size="sm" variant="secondary" asChild>
            <Link href={`/products/${product.slug}`}>Choose options</Link>
          </Button>
        )
      ) : (
        <Button size="sm" variant="secondary" disabled>
          Out of stock
        </Button>
      )}
      <button
        type="button"
        onClick={handleRemove}
        disabled={isPending}
        aria-label="Remove from wishlist"
        className="text-muted-foreground hover:text-destructive"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
