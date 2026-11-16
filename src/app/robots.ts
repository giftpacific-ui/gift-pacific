import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";
import { buildRobotsTxtRules } from "@/lib/seo-rules";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { getCanonicalOrigin } from "@/server/services/seo.service";

// Generated from Admin → SEO → Global settings. Private areas are ALWAYS disallowed; extra admin rules can never block
// an essential public route (they are filtered by buildRobotsTxtRules). Page-level noindex lives in meta robots, not here,
// because a crawler can only see a noindex tag on pages it is allowed to fetch.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await getCanonicalOrigin();
  let extra: string | null = null;
  try {
    extra = (await getStoreSettings()).seoRobotsExtra;
  } catch {
    // Database unavailable: serve the safe defaults rather than failing the crawl.
  }
  const { disallow } = buildRobotsTxtRules(extra);
  return {
    // Everything public (pages, product/category URLs, CSS, JS, images) stays crawlable. Filter/sort/search variants of the shop
    // stay crawlable ON PURPOSE: they carry noindex + a canonical to the clean listing, which crawlers only see if they may fetch them.
    rules: [{ userAgent: "*", allow: "/", disallow }],
    sitemap: absoluteUrl("/sitemap.xml", origin),
  };
}
