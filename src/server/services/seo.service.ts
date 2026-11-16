import "server-only";
import { cache } from "react";
import type { Metadata } from "next";
import { buildPageMetadata, siteOrigin, type PageSeo } from "@/lib/seo";
import { resolveSeoFields, mergeSeoOverrides, normalizeBaseUrl, type GlobalSeo, type SeoOverride } from "@/lib/seo-rules";
import { systemKeyForPath, systemPageByKey } from "@/lib/seo-pages";
import { cmsPageSeoOverride } from "@/lib/seo-cms";
import { getPublishedSystemPage } from "@/server/services/static-page.service";
import { siteConfig } from "@/config/site";
import { prisma } from "@/lib/db/prisma";
import { getStoreSettings } from "@/server/services/admin-settings.service";

/**
 * Server-side entry point for page metadata. Precedence for every field:
 *   [published CMS replacement's SEO fields >] Admin → SEO → Page SEO (or the record's own SEO fields)  >  the route's data-derived default  >  global settings.
 * getStoreSettings and getAllPageSeo are request-cached (one query each per request, shared with the root layout), and the
 * public pages are statically revalidated, so this adds no per-visitor database cost. Admin saves call revalidatePath.
 */

/** All Page SEO rows in ONE query (the table has one row per built-in route, so it is tiny). */
export const getAllPageSeo = cache(async () => {
  const rows = await prisma.pageSeo.findMany();
  return new Map(rows.map((r) => [r.key, r]));
});

export type PageSeoRow = Awaited<ReturnType<typeof getAllPageSeo>> extends Map<string, infer V> ? V : never;

/** Canonical origin: Admin setting when valid, otherwise the env-configured site URL. */
export const getCanonicalOrigin = cache(async (): Promise<string> => {
  const s = await getStoreSettings();
  const checked = normalizeBaseUrl(s.seoCanonicalBaseUrl);
  return checked.ok && checked.value ? checked.value : siteOrigin();
});

type SettingsRow = Awaited<ReturnType<typeof getStoreSettings>>;

export function toGlobalSeo(s: SettingsRow): GlobalSeo {
  return {
    defaultTitle: s.seoDefaultTitle,
    description: s.seoDescription || siteConfig.description,
    keywords: s.seoKeywords,
    ogTitle: s.seoOgTitle,
    ogDescription: s.seoOgDescription,
    ogImage: s.ogImageUrl || s.logoUrl,
    twitterCard: s.seoTwitterCard,
    defaultNoIndex: s.seoDefaultNoIndex,
    defaultNoFollow: s.seoDefaultNoFollow,
  };
}

/**
 * Builds metadata for a page. `override` is an explicit admin override (product/category/box/CMS-page fields). For built-in routes
 * it is looked up by `systemKey` (or derived from `seo.path`). `seo` carries the route's own defaults.
 */
export async function pageMetadata(seo: PageSeo, opts: { systemKey?: string; override?: SeoOverride | null } = {}): Promise<Metadata> {
  const [settings, pageRows, origin] = await Promise.all([getStoreSettings(), getAllPageSeo(), getCanonicalOrigin()]);
  const key = opts.systemKey ?? systemKeyForPath(seo.path);
  // Built-in pages whose body an admin replaced (About, Privacy, Terms, Shipping & returns): the published replacement's own SEO fields win,
  // then the Page SEO row, then the route default / global settings. Unpublished/deleted/empty replacement → Page SEO alone, as before.
  const cms = !opts.override && key && systemPageByKey(key)?.cms ? await getPublishedSystemPage(key) : null;
  const override: SeoOverride | null = opts.override ?? (key ? mergeSeoOverrides(cms ? cmsPageSeoOverride(cms) : null, pageRows.get(key)) : null);
  const r = resolveSeoFields(
    override,
    { title: seo.title, description: seo.description, keywords: seo.keywords, image: seo.image, noindex: seo.noindex },
    toGlobalSeo(settings),
  );
  return buildPageMetadata({
    ...seo,
    title: r.title ?? seo.title,
    titleIsCustom: r.titleFromOverride ? true : seo.titleIsCustom,
    description: r.description,
    keywords: r.keywords,
    image: r.image,
    noindex: r.noindex,
    nofollow: r.nofollow,
    robotsDirectives: r.directives,
    canonicalOverride: r.canonicalOverride,
    ogTitle: r.ogTitle,
    ogDescription: r.ogDescription,
    twitterCard: r.twitterCard,
    origin,
  });
}
