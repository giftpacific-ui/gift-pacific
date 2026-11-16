import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db/prisma";
import { sanitizeProductHtml } from "@/lib/sanitize-html";
import { SYSTEM_PAGES } from "@/lib/seo-pages";

/** Public reads for admin-managed pages. Only PUBLISHED rows are ever returned, and `html` is re-sanitized on every read. */

const publicSelect = {
  id: true, slug: true, systemKey: true, title: true, content: true, publishedAt: true, updatedAt: true,
  seoTitle: true, seoDescription: true, seoKeywords: true, canonicalUrl: true, ogImage: true, noIndex: true, noFollow: true, robotsDirectives: true,
} as const;

type Row = {
  id: string; slug: string; systemKey: string | null; title: string; content: string; publishedAt: Date | null; updatedAt: Date;
  seoTitle: string | null; seoDescription: string | null; seoKeywords: string[]; canonicalUrl: string | null; ogImage: string | null;
  noIndex: boolean; noFollow: boolean; robotsDirectives: string | null;
};

export type PublicStaticPage = Omit<Row, "content"> & { html: string };

const toPublic = ({ content, ...rest }: Row): PublicStaticPage => ({ ...rest, html: sanitizeProductHtml(content) });

/** A normal CMS page at /pages/<slug>. System-keyed pages are served by their own route, so they are excluded here (no duplicate URL). */
export const getPublishedPageBySlug = cache(async (slug: string): Promise<PublicStaticPage | null> => {
  const row = await prisma.staticPage.findFirst({ where: { slug, isPublished: true, systemKey: null }, select: publicSelect });
  return row ? toPublic(row) : null;
});

/**
 * CMS content for a built-in route (about-us, privacy, terms, shipping-returns). Returns null unless the admin has published
 * content for it AND it has text, so the built-in page keeps rendering until real replacement content exists.
 */
/** True when sanitized HTML has visible text. The ONE definition of "replacement content exists", shared by the page body, its metadata and the sitemap. */
export const hasRenderableText = (html: string) => html.replace(/<[^>]*>/g, "").trim().length > 0;

const CMS_SYSTEM_KEYS = SYSTEM_PAGES.filter((p) => p.cms).map((p) => p.key);

/**
 * Published, non-empty replacement content for the built-in routes, keyed by systemKey (at most a handful of rows, one query per
 * request). Unpublished, deleted or empty rows are absent, so the built-in page — and its normal SEO — applies.
 */
export const getPublishedSystemPages = cache(async (): Promise<Map<string, PublicStaticPage>> => {
  const rows = await prisma.staticPage.findMany({ where: { isPublished: true, systemKey: { in: CMS_SYSTEM_KEYS } }, select: publicSelect });
  const map = new Map<string, PublicStaticPage>();
  for (const row of rows) {
    const page = toPublic(row);
    if (row.systemKey && hasRenderableText(page.html)) map.set(row.systemKey, page);
  }
  return map;
});

export const getPublishedSystemPage = async (systemKey: string): Promise<PublicStaticPage | null> => (await getPublishedSystemPages()).get(systemKey) ?? null;

export const getFooterPages = cache(async () =>
  prisma.staticPage.findMany({
    where: { isPublished: true, showInFooter: true, systemKey: null },
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
    select: { slug: true, title: true },
    take: 12,
  }),
);
