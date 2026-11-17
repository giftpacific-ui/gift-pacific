"use client";

import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackAddToWishlist } from "@/lib/analytics/events";
import { useToggleWishlist, useWishlistIds } from "@/features/wishlist/use-wishlist";

/** `tracking` (name + display price) lets the AddToWishlist event carry real product data; without it no event is sent. */
export function WishlistButton({ productId, tracking }: { productId: string; tracking?: { name: string; price: number; currency?: string } }) {
  const { data: wishlistIds = [] } = useWishlistIds();
  const toggle = useToggleWishlist();
  const isSaved = wishlistIds.includes(productId);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate(productId, {
          onSuccess: (result) => {
            if (tracking && result.success && result.inWishlist) trackAddToWishlist({ id: productId, ...tracking });
          },
        });
      }}
      aria-label={isSaved ? "Remove from wishlist" : "Add to wishlist"}
      aria-pressed={isSaved}
      className="flex size-9 items-center justify-center rounded-full bg-background/95 shadow-sm backdrop-blur transition-colors hover:bg-background"
    >
      <Heart
        className={cn("size-4", isSaved ? "fill-primary text-primary" : "text-foreground")}
      />
    </button>
  );
}
