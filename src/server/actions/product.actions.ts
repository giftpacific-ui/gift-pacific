"use server";

import { getProductsByIds, getProductById } from "@/server/services/product.service";
import type { PublicProductCard, PublicProductDetail } from "@/lib/product-dto";

/** Returns PUBLIC card DTOs only (already plain numbers — no Decimal, no internal fields). */
export async function getProductsForIds(ids: string[]): Promise<PublicProductCard[]> {
  if (!Array.isArray(ids)) return [];
  return getProductsByIds(ids);
}

/** Returns the PUBLIC detail DTO only. */
export async function getProductForQuickView(
  productId: string,
): Promise<PublicProductDetail | null> {
  if (typeof productId !== "string" || !productId) return null;
  return getProductById(productId);
}
