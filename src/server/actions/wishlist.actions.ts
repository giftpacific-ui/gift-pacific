"use server";

import { revalidatePath } from "next/cache";
import {
  getWishlistProductIds,
  toggleWishlistItem as toggleWishlistItemService,
} from "@/server/services/wishlist.service";

export async function getWishlistIds() {
  return getWishlistProductIds();
}

export async function toggleWishlistItem(
  productId: string,
): Promise<{ success: true; inWishlist: boolean } | { success: false; message: string }> {
  try {
    const result = await toggleWishlistItemService(productId);
    revalidatePath("/account/wishlist");
    return { success: true, ...result };
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") {
      return { success: false, message: "UNAUTHENTICATED" };
    }
    return { success: false, message: "Could not update wishlist." };
  }
}
