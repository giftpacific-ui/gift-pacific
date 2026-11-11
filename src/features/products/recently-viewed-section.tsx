"use client";

import { useEffect, useState } from "react";
import {
  useRecentlyViewedIds,
  useRecordRecentlyViewed,
} from "@/features/products/use-recently-viewed";
import { getProductsForIds } from "@/server/actions/product.actions";
import { recordAndGetRecentlyViewedAction } from "@/server/actions/recently-viewed.actions";
import { ProductSection } from "@/features/home/product-section";
import type { PublicProductCard } from "@/lib/product-dto";

/**
 * Drop this on a product detail page: records the view and shows past views.
 * Signed-in customers get a database-backed history (it follows them across devices); guests keep the local one.
 */
export function RecordAndShowRecentlyViewed({ productId }: { productId: string }) {
  useRecordRecentlyViewed(productId);
  const ids = useRecentlyViewedIds(productId);
  const [serverProducts, setServerProducts] = useState<PublicProductCard[] | null | undefined>(undefined); // undefined = still asking
  const [localProducts, setLocalProducts] = useState<PublicProductCard[]>([]);

  // One call per product per tab session records the view and returns the history (no write on every render).
  useEffect(() => {
    let cancelled = false;
    recordAndGetRecentlyViewedAction(productId)
      .then((result) => !cancelled && setServerProducts(result.signedIn ? result.products : null))
      .catch(() => !cancelled && setServerProducts(null));
    return () => {
      cancelled = true;
    };
  }, [productId]);

  // Guests only: resolve the locally stored ids.
  useEffect(() => {
    if (serverProducts !== null || ids.length === 0) return;
    let cancelled = false;
    getProductsForIds(ids.slice(0, 8)).then((result) => {
      if (!cancelled) setLocalProducts(result);
    });
    return () => {
      cancelled = true;
    };
  }, [ids, serverProducts]);

  const products = serverProducts ?? localProducts;
  if (products.length === 0) return null;

  return <ProductSection title="Recently viewed" products={products} />;
}
