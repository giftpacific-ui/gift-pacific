import type { Prisma } from "@prisma/client";

/**
 * "In stock" as a database filter. MUST stay equivalent to
 * `getProductAvailability(...).inStock` in `lib/stock.ts` (a unit test
 * evaluates both over a grid of products and asserts they agree):
 *
 *  - non-VARIANT products: untracked, OR backorder allowed, OR stock > 0
 *  - VARIANT products:     at least one variant that is untracked-by-product,
 *                          backorder-allowed, or has stock > 0.
 *                          Product-level stock is ignored; a variant product
 *                          with no purchasable variant is never "in stock".
 */
export function inStockWhere(): Prisma.ProductWhereInput {
  return {
    OR: [
      {
        type: { not: "VARIANT" },
        OR: [{ trackInventory: false }, { allowBackorder: true }, { stock: { gt: 0 } }],
      },
      {
        type: "VARIANT",
        variants: {
          some: {
            OR: [
              { allowBackorder: true },
              { stock: { gt: 0 } },
              { product: { trackInventory: false } },
            ],
          },
        },
      },
    ],
  };
}

export const PRODUCT_SORTS = ["newest", "price-asc", "price-desc", "best-selling"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export function toSort(value: unknown): ProductSort {
  return (PRODUCT_SORTS as readonly unknown[]).includes(value) ? (value as ProductSort) : "newest";
}

/** Whole number >= 1 (and <= max), else the fallback. Guards NaN from `Number("abc")`. */
export function toPositiveInt(value: unknown, fallback: number, max = 10_000): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
