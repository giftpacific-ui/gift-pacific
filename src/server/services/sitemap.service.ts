import "server-only";
import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db/prisma";
import { absoluteUrl } from "@/lib/seo";
import { getActiveCampaign } from "@/server/services/campaign.service";

/**
 * Sitemap data. Products are paged in fixed-size chunks (one sitemap file per chunk, referenced from a sitemap index),
 * so the catalog is never loaded into memory as a whole and every file stays far below the 50,000-URL protocol limit.
 */
export const PRODUCTS_PER_SITEMAP = 5000;

/** Public, indexable products only: ACTIVE, not a box's hidden backing product, not switched to noindex. */
const productWhere = { status: "ACTIVE", isBoxProduct: false, seoNoIndex: false } as const;

export async function getProductSitemapCount(): Promise<number> {
  const total = await prisma.product.count({ where: productWhere });
  return Math.ceil(total / PRODUCTS_PER_SITEMAP);
}

/** Sitemap ids: 0 = pages, categories, boxes, campaign; 1..n = product chunks. */
export async function getSitemapIds(): Promise<number[]> {
  const chunks = await getProductSitemapCount();
  return Array.from({ length: chunks + 1 }, (_, i) => i);
}

export async function getProductSitemapEntries(chunk: number): Promise<MetadataRoute.Sitemap> {
  const rows = await prisma.product.findMany({
    where: productWhere,
    orderBy: { id: "asc" }, // stable order, so chunk boundaries never shift between requests
    skip: chunk * PRODUCTS_PER_SITEMAP,
    take: PRODUCTS_PER_SITEMAP,
    select: { slug: true, updatedAt: true },
  });
  return rows.map((p) => ({ url: absoluteUrl(`/products/${p.slug}`), lastModified: p.updatedAt }));
}

export async function getPageSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const [latestProduct, categories, campaign, boxes] = await Promise.all([
    prisma.product.aggregate({ where: productWhere, _max: { updatedAt: true } }),
    prisma.category.findMany({ where: { isActive: true, seoNoIndex: false }, select: { slug: true, updatedAt: true } }),
    getActiveCampaign(),
    prisma.box.findMany({ where: { isActive: true }, select: { slug: true, updatedAt: true } }),
  ]);

  // Pages with no stored timestamp get none: inventing "now" for every URL would teach crawlers to ignore lastmod.
  const staticPaths = ["/boxes", "/build-your-own-combo", "/about-us", "/contact", "/shipping-returns", "/career", "/privacy", "/terms"];
  return [
    { url: absoluteUrl("/"), lastModified: latestProduct._max.updatedAt ?? undefined },
    { url: absoluteUrl("/shop"), lastModified: latestProduct._max.updatedAt ?? undefined },
    ...staticPaths.map((path) => ({ url: absoluteUrl(path) })),
    ...(campaign ? [{ url: absoluteUrl("/campaign"), lastModified: campaign.updatedAt }] : []),
    ...categories.map((c) => ({ url: absoluteUrl(`/shop/${c.slug}`), lastModified: c.updatedAt })),
    ...boxes.map((b) => ({ url: absoluteUrl(`/boxes/${b.slug}`), lastModified: b.updatedAt })),
  ];
}
