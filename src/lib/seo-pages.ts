/**
 * Built-in public routes whose SEO is editable in Admin → SEO → Page SEO, plus the slug rules for CMS pages.
 * Pure data/validation (no server imports) so it is shared by services, actions, UI and tests.
 */

export type SystemPage = { key: string; path: string; label: string; /** CMS content can replace the built-in body. */ cms?: boolean };

export const SYSTEM_PAGES: readonly SystemPage[] = [
  { key: "home", path: "/", label: "Homepage" },
  { key: "shop", path: "/shop", label: "Shop (all products)" },
  { key: "boxes", path: "/boxes", label: "Gift boxes" },
  { key: "build-your-own-combo", path: "/build-your-own-combo", label: "Build your own combo" },
  { key: "campaign", path: "/campaign", label: "Campaign" },
  { key: "about-us", path: "/about-us", label: "About us", cms: true },
  { key: "contact", path: "/contact", label: "Contact us" },
  { key: "shipping-returns", path: "/shipping-returns", label: "Shipping & returns", cms: true },
  { key: "privacy", path: "/privacy", label: "Privacy policy", cms: true },
  { key: "terms", path: "/terms", label: "Terms & conditions", cms: true },
  { key: "career", path: "/career", label: "Careers" },
];

export const SYSTEM_PAGE_KEYS = new Set(SYSTEM_PAGES.map((p) => p.key));

export function systemPageByKey(key: string): SystemPage | undefined {
  return SYSTEM_PAGES.find((p) => p.key === key);
}

export function systemKeyForPath(path: string): string | undefined {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return SYSTEM_PAGES.find((p) => p.path === clean)?.key;
}

/** URL path of a CMS page: system-keyed pages live on their own route, the rest under /pages/. */
export function staticPagePath(page: { slug: string; systemKey?: string | null }): string {
  const sys = page.systemKey ? systemPageByKey(page.systemKey) : undefined;
  return sys ? sys.path : `/pages/${page.slug}`;
}

/** First path segments that belong to the application (routes, assets, crawlers). A CMS slug may never equal one. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin", "api", "account", "cart", "checkout", "login", "register", "forgot-password", "reset-password", "logout",
  "search", "shop", "products", "product", "categories", "category", "boxes", "box", "campaign", "campaigns", "career", "careers",
  "contact", "about", "about-us", "privacy", "terms", "shipping-returns", "build-your-own-combo", "docs", "pages", "page",
  "sitemap", "sitemap-index", "sitemap.xml", "robots.txt", "favicon.ico", "_next", "static", "public", "images", "img",
  "wishlist", "orders", "order", "track", "auth", "oauth", "webhooks", "webhook", "new", "edit",
]);

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SlugCheck = { ok: true; slug: string } | { ok: false; error: string };

/** Lower-cases/trims and validates a CMS slug. System-keyed pages are created by the app, never through this check. */
export function validatePageSlug(input: string): SlugCheck {
  const slug = input.trim().toLowerCase();
  if (slug.length < 2 || slug.length > 80) return { ok: false, error: "Slug must be 2–80 characters." };
  if (!SLUG_RE.test(slug)) return { ok: false, error: "Use only lowercase letters, numbers and single hyphens (no spaces, slashes or dots)." };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: `"${slug}" is reserved for the application. Choose another slug.` };
  return { ok: true, slug };
}

/** Suggests a slug from a title (ASCII only; callers must still validate). */
export function slugFromTitle(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
