import "server-only";
import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db/prisma";
import { absoluteUrl } from "@/lib/seo";
import { isSitemapEligible, mergeSeoOverrides } from "@/lib/seo-rules";
import { cmsPageSeoOverride } from "@/lib/seo-cms";
import { getPublishedSystemPages } from "@/server/services/static-page.service";
import { SYSTEM_PAGES } from "@/lib/seo-pages";
import { getAllPageSeo, getCanonicalOrigin } from "@/server/services/seo.service";
import { getActiveCampaign } from "@/server/services/campaign.service";

/**
 * Sitemap data. Products are paged in fixed-size chunks (one sitemap file per chunk, referenced from a sitemap index),
 * so the catalog is never loaded into memory as a whole and every file stays far below the 50,000-URL protocol limit.
 */
export const PRODUCTS_PER_SITEMAP = 5000;

/** Public, indexable products only: ACTIVE, not a box's hidden backing product, not switched to noindex. */
/** (A product whose admin canonical points to a DIFFERENT URL is also left out in getProductSitemapEntries: only canonical URLs are listed.) */
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
  const [rows, origin] = await Promise.all([
    prisma.product.findMany({
      where: productWhere,
      orderBy: { id: "asc" }, // stable order, so chunk boundaries never shift between requests
      skip: chunk * PRODUCTS_PER_SITEMAP,
      take: PRODUCTS_PER_SITEMAP,
      select: { slug: true, updatedAt: true, seoCanonicalUrl: true },
    }),
    getCanonicalOrigin(),
  ]);
  return rows
    .filter((p) => isSitemapEligible({ path: `/products/${p.slug}`, canonical: p.seoCanonicalUrl }, origin))
    .map((p) => ({ url: absoluteUrl(`/products/${p.slug}`, origin), lastModified: p.updatedAt }));
}

export async function getPageSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const [origin, latestProduct, categories, campaign, boxes, pageSeo, cmsPages, systemCms] = await Promise.all([
    getCanonicalOrigin(),
    prisma.product.aggregate({ where: productWhere, _max: { updatedAt: true } }),
    prisma.category.findMany({ where: { isActive: true, seoNoIndex: false }, select: { slug: true, updatedAt: true, seoCanonicalUrl: true } }),
    getActiveCampaign(),
    prisma.box.findMany({ where: { isActive: true, seoNoIndex: false }, select: { slug: true, updatedAt: true, seoCanonicalUrl: true } }),
    getAllPageSeo(),
    prisma.staticPage.findMany({
      where: { isPublished: true, noIndex: false, systemKey: null },
      select: { slug: true, systemKey: true, updatedAt: true, canonicalUrl: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
    getPublishedSystemPages(),
  ]);
  const ok = (path: string, noindex?: boolean | null, canonical?: string | null) => isSitemapEligible({ path, noindex, canonical }, origin);

  // Built-in routes: omitted when the admin marked them noindex or pointed their canonical elsewhere. "/campaign" is listed
  // only while a campaign is active. Pages with no stored timestamp get none (inventing "now" would teach crawlers to ignore lastmod).
  const system = SYSTEM_PAGES.filter((p) => p.key !== "campaign" || campaign).map((p) => {
    // Same precedence as pageMetadata(): the published CMS replacement's noIndex/canonical (only when it has real content) then Page SEO.
    const cms = systemCms.get(p.key);
    const eff = mergeSeoOverrides(cms ? cmsPageSeoOverride(cms) : null, pageSeo.get(p.key));
    const lastModified = p.key === "home" || p.key === "shop" ? (latestProduct._max.updatedAt ?? undefined) : p.key === "campaign" ? campaign?.updatedAt : cms?.updatedAt;
    return { path: p.path, noindex: eff.noIndex, canonical: eff.canonicalUrl, lastModified };
  });
  const entries = [
    ...system.filter((p) => ok(p.path, p.noindex, p.canonical)).map((p) => ({ url: absoluteUrl(p.path, origin), lastModified: p.lastModified })),
    ...cmsPages.filter((p) => ok(`/pages/${p.slug}`, false, p.canonicalUrl)).map((p) => ({ url: absoluteUrl(`/pages/${p.slug}`, origin), lastModified: p.updatedAt })),
    ...categories.filter((c) => ok(`/shop/${c.slug}`, false, c.seoCanonicalUrl)).map((c) => ({ url: absoluteUrl(`/shop/${c.slug}`, origin), lastModified: c.updatedAt })),
    ...boxes.filter((b) => ok(`/boxes/${b.slug}`, false, b.seoCanonicalUrl)).map((b) => ({ url: absoluteUrl(`/boxes/${b.slug}`, origin), lastModified: b.updatedAt })),
  ];
  // One URL, one entry (first wins), whatever combination of sources produced it.
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}
