import { absoluteUrl } from "@/lib/seo";
import { getSitemapIds } from "@/server/services/sitemap.service";
import { getCanonicalOrigin } from "@/server/services/seo.service";

// robots.txt advertises /sitemap.xml, but `sitemap.ts` uses generateSitemaps(), which only serves the numbered
// chunks (/sitemap/0.xml = pages, /sitemap/1.xml... = products) and no index, so that URL was a 404. This is the
// standard sitemap *index* pointing at the existing chunks. It lives at /sitemap-index and next.config.ts rewrites
// /sitemap.xml to it (a file-system route at /sitemap.xml would conflict with the sitemap.ts metadata convention).
export const dynamic = "force-dynamic";

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export async function GET() {
  const [ids, origin] = await Promise.all([getSitemapIds(), getCanonicalOrigin()]);
  const entries = ids.map((id) => `  <sitemap><loc>${escapeXml(absoluteUrl(`/sitemap/${id}.xml`, origin))}</loc></sitemap>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=3600" },
  });
}
