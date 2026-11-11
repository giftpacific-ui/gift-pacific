"use server";

import { listProducts } from "@/server/services/product.service";

/** Public fields only — nothing here can carry cost, stock counts or internal ids. */
export type SearchSuggestion = {
  name: string;
  slug: string;
  price: number;
  imageUrl: string | null;
  categoryName: string | null;
  inStock: boolean;
};

const MIN_QUERY = 2;
const MAX_QUERY = 80;

/**
 * Live suggestions for the search overlay. Same product source and public DTO
 * as the shop/search pages (ACTIVE products only); the full results page
 * (/search?q=…) stays the source of truth.
 */
export async function searchSuggestionsAction(query: string): Promise<SearchSuggestion[]> {
  if (typeof query !== "string") return [];
  const q = query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
  if (q.length < MIN_QUERY) return [];

  const { items } = await listProducts({ search: q, pageSize: 6, page: 1 });
  return items.map((p) => ({
    name: p.name,
    slug: p.slug,
    price: p.price,
    imageUrl: p.images[0]?.url ?? null,
    categoryName: p.category?.name ?? null,
    inStock: p.availability.inStock,
  }));
}
