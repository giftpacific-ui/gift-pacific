"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { getWishlistIds, toggleWishlistItem } from "@/server/actions/wishlist.actions";

export const WISHLIST_QUERY_KEY = ["wishlist-ids"] as const;

export function useWishlistIds() {
  return useQuery({
    queryKey: WISHLIST_QUERY_KEY,
    queryFn: () => getWishlistIds(),
  });
}

export function useToggleWishlist() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: (productId: string) => toggleWishlistItem(productId),
    onSuccess: (result) => {
      if (!result.success) {
        if (result.message === "UNAUTHENTICATED") {
          toast.info("Sign in to save items to your wishlist");
          router.push("/login");
        } else {
          toast.error(result.message);
        }
        return;
      }
      toast.success(result.inWishlist ? "Added to wishlist" : "Removed from wishlist");
      queryClient.invalidateQueries({ queryKey: WISHLIST_QUERY_KEY });
    },
  });
}
