import type { SeoOverride } from "@/lib/seo-rules";

/** Maps a CMS page row to the shared SEO override shape (title/description fall back to the page's own title/text). */
export function cmsPageSeoOverride(p: {
  seoTitle: string | null; seoDescription: string | null; seoKeywords: string[]; canonicalUrl: string | null;
  ogImage: string | null; noIndex: boolean; noFollow: boolean; robotsDirectives: string | null;
}): SeoOverride {
  return {
    title: p.seoTitle, description: p.seoDescription, keywords: p.seoKeywords, canonicalUrl: p.canonicalUrl,
    ogImage: p.ogImage, noIndex: p.noIndex, noFollow: p.noFollow, robotsDirectives: p.robotsDirectives,
  };
}
