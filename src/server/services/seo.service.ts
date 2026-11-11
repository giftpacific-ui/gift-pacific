import "server-only";
import type { Metadata } from "next";
import { buildPageMetadata, type PageSeo } from "@/lib/seo";
import { siteConfig } from "@/config/site";
import { getStoreSettings } from "@/server/services/admin-settings.service";

/**
 * Server-side entry point for page metadata. Fills the store-wide defaults from Admin → Settings → Site & SEO
 * (description, share image) when a page has none of its own, then delegates to the pure builder in lib/seo.ts.
 * getStoreSettings is request-cached, so this costs nothing extra next to the root layout's own call.
 */
export async function pageMetadata(seo: PageSeo): Promise<Metadata> {
  const settings = await getStoreSettings();
  return buildPageMetadata({
    ...seo,
    description: seo.description || settings.seoDescription || siteConfig.description,
    image: seo.image || settings.ogImageUrl || settings.logoUrl,
  });
}
