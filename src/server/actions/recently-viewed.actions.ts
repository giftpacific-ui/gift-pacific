"use server";

import { getMyRecentlyViewed, recordProductView } from "@/server/services/recently-viewed.service";
import type { PublicProductCard } from "@/lib/product-dto";

/** Records the view (signed-in customers only) and returns their history; `signedIn: false` tells guests to use local history. */
export async function recordAndGetRecentlyViewedAction(
  productId: string,
): Promise<{ signedIn: false } | { signedIn: true; products: PublicProductCard[] }> {
  const recorded = await recordProductView(productId);
  if (!recorded) {
    // Either a guest, or a product that must not be recorded. Signed-in customers still see their existing history.
    const products = await getMyRecentlyViewed(8, productId);
    return products.length > 0 ? { signedIn: true, products } : { signedIn: false };
  }
  return { signedIn: true, products: await getMyRecentlyViewed(8, productId) };
}
