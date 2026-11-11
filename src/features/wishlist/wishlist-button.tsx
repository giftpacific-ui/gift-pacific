"use client";

import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToggleWishlist, useWishlistIds } from "@/features/wishlist/use-wishlist";

export function WishlistButton({ productId }: { productId: string }) {
  const { data: wishlistIds = [] } = useWishlistIds();
  const toggle = useToggleWishlist();
  const isSaved = wishlistIds.includes(productId);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate(productId);
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
