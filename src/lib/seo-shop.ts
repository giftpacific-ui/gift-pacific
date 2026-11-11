/** Canonical URL + indexing rules for /shop and category pages (pure, tested). */
export type ShopSeoInput = {
  siteUrl: string;
  /** Category path segments from the URL, e.g. ["mugs"] or ["home", "mugs"]. */
  path: readonly string[];
  /** Raw query parameters of the request. */
  query: Record<string, string | string[] | undefined>;
  categoryFound: boolean;
};

const PAGE_ONLY = new Set(["page"]);
/** Campaign/tracking parameters never change the content, so they neither noindex the page nor appear in the canonical. */
const TRACKING = /^(utm_|fbclid$|gclid$|msclkid$|ttclid$|ref$)/i;

export function shopSeo(i: ShopSeoInput): { canonical: string; robots: { index: boolean; follow: boolean } } {
  const base = `${i.siteUrl.replace(/\/+$/, "")}/shop${i.path.length ? `/${i.path.map(encodeURIComponent).join("/")}` : ""}`;
  const keys = Object.entries(i.query).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)).map(([k]) => k);
  const filtered = keys.some((k) => !PAGE_ONLY.has(k) && !TRACKING.test(k));   // filters, sort, search, price… = duplicate views of the same listing
  const pageRaw = Array.isArray(i.query.page) ? i.query.page[0] : i.query.page;
  const page = Number.parseInt(pageRaw ?? "1", 10);
  const paged = Number.isInteger(page) && page > 1;
  // Filtered/sorted views point at the clean listing and are kept out of the index; real pagination keeps its own URL.
  const canonical = !filtered && paged ? `${base}?page=${page}` : base;
  const index = i.categoryFound && !filtered;
  return { canonical, robots: { index, follow: true } };
}
