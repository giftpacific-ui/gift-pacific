import "server-only";
import { cache } from "react";
import { publicReviewWhere } from "@/lib/review-rules";
import { getComboPublicView } from "@/server/services/combo.service";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";
import {
  toPublicProductCard,
  toPublicProductDetail,
  toPublicReview,
  type PublicProductCard,
  type PublicProductDetail,
  type PublicReview,
} from "@/lib/product-dto";
import { inStockWhere, toPositiveInt, toOptionalNumber, toSort } from "@/lib/product-queries";

/**
 * Every storefront read goes through an explicit `select` (so internal
 * columns like costPrice are never even fetched) AND through a public
 * mapper in `lib/product-dto.ts` (so nothing internal can reach a client
 * component, even if a select is later widened by mistake).
 */
const cardSelect = {
  id: true,
  name: true,
  slug: true,
  shortDescription: true,
  type: true,
  kind: true,
  comboMode: true,
  comboStockPolicy: true,
  badges: true,
  currency: true,
  price: true,
  compareAtPrice: true,
  videoUrl: true,
  // Needed ONLY to compute availability in the mapper; never output.
  stock: true,
  allowBackorder: true,
  trackInventory: true,
  images: {
    select: { url: true, altText: true },
    orderBy: { sortOrder: "asc" as const },
    take: 2,
  },
  category: { select: { name: true, slug: true } },
  // ALL variants (not take: 1) so availability reflects every variant.
  variants: { select: { price: true, stock: true, allowBackorder: true } },
} satisfies Prisma.ProductSelect;

/** @deprecated alias kept for existing imports — this IS the public card DTO. */
export type ProductCardData = PublicProductCard;
export type ProductDetailData = PublicProductDetail;

function cards(rows: Parameters<typeof toPublicProductCard>[0][]): PublicProductCard[] {
  return rows.map(toPublicProductCard);
}

export async function getFeaturedProducts(limit = 8): Promise<PublicProductCard[]> {
  return cards(
    await prisma.product.findMany({
      where: { status: "ACTIVE", isBoxProduct: false, isFeatured: true },
      select: cardSelect,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );
}

export async function getNewArrivals(limit = 8): Promise<PublicProductCard[]> {
  return cards(
    await prisma.product.findMany({
      where: { status: "ACTIVE", isBoxProduct: false },
      select: cardSelect,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );
}

export async function getBestSellers(limit = 8): Promise<PublicProductCard[]> {
  return cards(
    await prisma.product.findMany({
      where: { status: "ACTIVE", isBoxProduct: false, badges: { has: "BEST_SELLER" } },
      select: cardSelect,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );
}

export async function getLimitedEditionProducts(limit = 8): Promise<PublicProductCard[]> {
  return cards(
    await prisma.product.findMany({
      where: { status: "ACTIVE", isBoxProduct: false, badges: { has: "LIMITED_EDITION" } },
      select: cardSelect,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );
}

export async function getGiftBundles(limit = 6): Promise<PublicProductCard[]> {
  return cards(
    await prisma.product.findMany({
      where: { status: "ACTIVE", isBoxProduct: false, type: "BUNDLE" },
      select: cardSelect,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );
}

export async function getFeaturedCategories(limit = 6) {
  return prisma.category.findMany({
    where: { isFeatured: true },
    orderBy: { sortOrder: "asc" },
    take: limit,
  });
}

export async function getProductsByIds(ids: string[]): Promise<PublicProductCard[]> {
  const safeIds = ids.filter((id): id is string => typeof id === "string").slice(0, 24);
  if (safeIds.length === 0) return [];
  const products = cards(
    await prisma.product.findMany({
      where: { id: { in: safeIds }, status: "ACTIVE" },
      select: cardSelect,
    }),
  );
  // Preserve the caller's ordering (most-recently-viewed first).
  const order = new Map(safeIds.map((id, index) => [id, index]));
  return products.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function getAllCategories() {
  return prisma.category.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
}

/** Full category tree (active categories only) for shop filter sidebars and nav. */
export async function getCategoryTree() {
  const categories = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  type Node = (typeof categories)[number] & { children: Node[] };
  const byId = new Map<string, Node>(categories.map((c) => [c.id, { ...c, children: [] }]));
  const roots: Node[] = [];
  for (const category of categories) {
    const node = byId.get(category.id)!;
    if (category.parentId && byId.has(category.parentId)) {
      byId.get(category.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Ancestor chain from root down to (and including) the given category — for breadcrumbs. */
export async function getCategoryBreadcrumb(categoryId: string) {
  const chain: { id: string; name: string; slug: string }[] = [];
  let current = await prisma.category.findUnique({ where: { id: categoryId } });
  while (current) {
    chain.unshift({ id: current.id, name: current.name, slug: current.slug });
    current = current.parentId
      ? await prisma.category.findUnique({ where: { id: current.parentId } })
      : null;
  }
  return chain;
}

/** All descendant category IDs (including the category itself) — used so filtering by a
 *  parent category also includes products assigned to its subcategories. */
export async function getCategoryAndDescendantIds(categoryId: string) {
  const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
  const childrenOf = new Map<string, string[]>();
  for (const c of all) {
    if (!c.parentId) continue;
    if (!childrenOf.has(c.parentId)) childrenOf.set(c.parentId, []);
    childrenOf.get(c.parentId)!.push(c.id);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  function walk(id: string) {
    if (seen.has(id)) return; // guards against a corrupt parent cycle
    seen.add(id);
    ids.push(id);
    for (const childId of childrenOf.get(id) ?? []) walk(childId);
  }
  walk(categoryId);
  return ids;
}

export type BannerPlacementName = "HERO" | "PROMO_STRIP" | "MID_PAGE" | "CAMPAIGN" | "POPUP";

export async function getActiveBanners(placement: BannerPlacementName) {
  const now = new Date();
  return prisma.banner.findMany({
    where: {
      placement,
      isActive: true,
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
    },
    orderBy: { sortOrder: "asc" },
  });
}

export type ProductListFilters = {
  categorySlug?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  type?: Prisma.ProductWhereInput["type"];
  /** SINGLE / COMBO. Independent of category: both filters apply together. */
    kind?: "SINGLE" | "COMBO";
  /** Typed AND-clauses from attribute filters (see resolveAttributeWhere). */
  attributeWhere?: Prisma.ProductWhereInput[];
  inStockOnly?: boolean;
  tagSlugs?: string[];
  isFeatured?: boolean;
  /** Restrict to products in one collection (used by the campaign page). */
  collectionId?: string;
  badges?: ("NEW" | "BEST_SELLER")[];
  sort?: "newest" | "price-asc" | "price-desc" | "best-selling";
  page?: number;
  pageSize?: number;
};

export async function listProducts(filters: ProductListFilters) {
  const {
    categorySlug,
        search,
        type,
    kind,
    attributeWhere,
    inStockOnly,
    tagSlugs,
    isFeatured,
    badges,
    collectionId,
  } = filters;
  // Query-string-derived values: never trust them to be finite numbers.
  const sort = toSort(filters.sort);
  const page = toPositiveInt(filters.page, 1);
  const pageSize = toPositiveInt(filters.pageSize, 12, 60);
  const minPrice = toOptionalNumber(filters.minPrice);
  const maxPrice = toOptionalNumber(filters.maxPrice);

  let categoryIds: string[] | null = null;
  if (categorySlug) {
    const category = await prisma.category.findUnique({ where: { slug: categorySlug } });
    // Filtering by a parent category also includes products in its
    // subcategories/child categories, not just products assigned directly.
    categoryIds = category ? await getCategoryAndDescendantIds(category.id) : [];
  }

  // `AND` so the stock filter (which has its own OR) can't collide with the search OR.
  const and: Prisma.ProductWhereInput[] = [];
  if (inStockOnly) and.push(inStockWhere());
  if (search) {
    and.push({
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { shortDescription: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  const where: Prisma.ProductWhereInput = {
    status: "ACTIVE", isBoxProduct: false,
    ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
    ...(type ? { type } : {}),
    ...(kind ? { kind } : {}),
    
    ...(isFeatured ? { isFeatured: true } : {}),
    ...(collectionId ? { collections: { some: { collectionId } } } : {}),
    ...(badges && badges.length > 0 ? { badges: { hasSome: badges } } : {}),
    ...(minPrice !== undefined || maxPrice !== undefined
      ? {
          price: {
            ...(minPrice !== undefined ? { gte: minPrice } : {}),
            ...(maxPrice !== undefined ? { lte: maxPrice } : {}),
          },
        }
      : {}),
    ...(tagSlugs && tagSlugs.length > 0
      ? { tags: { some: { tag: { slug: { in: tagSlugs } } } } }
      : {}),
        ...(and.length > 0 || (attributeWhere && attributeWhere.length > 0)
      ? { AND: [...and, ...(attributeWhere ?? [])] }
      : {}),
  };

  // Default ordering shows COMBOS FIRST, then single products (newest first within each).
  // `kind` is an enum declared SINGLE, COMBO, and PostgreSQL orders enums by declaration,
  // so DESC puts combos first. An explicit price sort is a deliberate choice and wins.
  const orderBy: Prisma.ProductOrderByWithRelationInput[] =
    sort === "price-asc"
      ? [{ price: "asc" }, { id: "asc" }]
      : sort === "price-desc"
        ? [{ price: "desc" }, { id: "asc" }]
        : [{ kind: "desc" }, { createdAt: "desc" }, { id: "asc" }]; // "best-selling" falls back to newest until sales stats exist

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      select: cardSelect,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items: cards(rows),
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
  };
}

const detailSelect = {
  ...cardSelect,
  description: true,
  sku: true,
  categoryId: true,
  images: {
    select: { url: true, altText: true },
    orderBy: { sortOrder: "asc" as const },
  },
  variants: {
    select: {
      id: true,
      name: true,
      price: true,
      options: true,
      image: true,
      isDefault: true,
      stock: true,
      allowBackorder: true,
    },
    orderBy: [{ isDefault: "desc" as const }, { price: "asc" as const }],
  },
  customizationFields: {
    select: {
      label: true,
      fieldKey: true,
      type: true,
      isRequired: true,
      options: true,
      maxLength: true,
    },
    orderBy: { sortOrder: "asc" as const },
  },
  bundleItems: {
    select: {
      quantity: true,
      component: {
        select: {
          name: true,
          images: { where: { isMain: true }, take: 1, select: { url: true } },
        },
      },
    },
  },
} satisfies Prisma.ProductSelect;

const reviewSelect = {
  rating: true,
  title: true,
  body: true,
  createdAt: true,
  orderItemId: true,
  user: { select: { name: true } },
} satisfies Prisma.ReviewSelect;

export type ProductPageData = {
  product: PublicProductDetail;
  /** Server-only: used for related products / breadcrumb. Never pass to a client component. */
  categoryId: string | null;
  reviews: PublicReview[];
};

/** SEO fields for generateMetadata (kept separate so the page DTO stays unchanged). */
export const getProductStockPolicy = cache(async (slug: string) => {
  return prisma.product.findFirst({
    where: { slug, status: "ACTIVE" },
    select: { trackInventory: true, allowBackorder: true, type: true, stock: true, variants: { select: { stock: true, allowBackorder: true } } },
  });
});

/** Cached per request: generateMetadata and the page share one query. Only ACTIVE products are ever returned. */
export const getProductSeo = cache(async (slug: string) => {
  return prisma.product.findFirst({
    where: { slug, status: "ACTIVE" },
    select: { metaTitle: true, metaDescription: true, metaKeywords: true, isBoxProduct: true, seoImage: true, seoNoIndex: true, brand: true, updatedAt: true },
  });
});

export const getProductBySlug = cache(async (slug: string): Promise<ProductPageData | null> => {
  const row = await prisma.product.findFirst({
    where: { slug, status: "ACTIVE" },
    select: {
      ...detailSelect,
      reviews: { where: publicReviewWhere(), select: reviewSelect, orderBy: { createdAt: "desc" } },
    },
  });
  if (!row) return null;
    const { reviews, categoryId, ...rest } = row;
  const product = toPublicProductDetail(rest);
  if (row.kind === "COMBO") {
    const view = await getComboPublicView(row.id);
    if (view.availability) product.availability = view.availability;
    product.combo = view.builder;
  }
  return {
    product,
    categoryId,
    reviews: reviews.map(toPublicReview),
  };
});

/** Same public detail shape, keyed by id — used by the Quick View modal. */
export async function getProductById(id: string): Promise<PublicProductDetail | null> {
  const row = await prisma.product.findFirst({
    where: { id, status: "ACTIVE" },
    select: detailSelect,
  });
  return row ? toPublicProductDetail(row) : null;
}

export async function getRelatedProducts(
  productId: string,
  categoryId: string | null,
  limit = 4,
): Promise<PublicProductCard[]> {
  return cards(
    await prisma.product.findMany({
      where: {
        status: "ACTIVE", isBoxProduct: false,
        id: { not: productId },
        ...(categoryId ? { categoryId } : {}),
      },
      select: cardSelect,
      take: limit,
    }),
  );
}

/**
 * Products that have historically appeared in the same orders as this one.
 * Falls back to same-category picks when there isn't enough order history yet
 * (e.g. a brand-new store with no orders).
 */
export async function getFrequentlyBoughtTogether(
  productId: string,
  categoryId: string | null,
  limit = 4,
): Promise<PublicProductCard[]> {
  const coOccurringOrderItems = await prisma.orderItem.findMany({
    where: {
      productId: { not: productId },
      order: { items: { some: { productId } } },
    },
    select: { productId: true },
    distinct: ["productId"],
    take: limit * 3,
  });

  const coOccurringIds = coOccurringOrderItems.map((i) => i.productId);

  if (coOccurringIds.length >= limit) {
    return cards(
      await prisma.product.findMany({
        where: { id: { in: coOccurringIds }, status: "ACTIVE" },
        select: cardSelect,
        take: limit,
      }),
    );
  }

  // Not enough purchase history yet — top up with same-category products.
  const fallback = await prisma.product.findMany({
    where: {
      status: "ACTIVE", isBoxProduct: false,
      id: { notIn: [productId, ...coOccurringIds] },
      ...(categoryId ? { categoryId } : {}),
    },
    select: cardSelect,
    take: limit - coOccurringIds.length,
  });

  const primary =
    coOccurringIds.length > 0
      ? await prisma.product.findMany({
          where: { id: { in: coOccurringIds }, status: "ACTIVE" },
          select: cardSelect,
        })
      : [];

  return cards([...primary, ...fallback]);
}
