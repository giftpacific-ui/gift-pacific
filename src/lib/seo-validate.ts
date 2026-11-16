/**
 * Pure server-side validation of every SEO form (global settings, page SEO, product/category/box SEO, static pages, redirects).
 * Actions call these with the raw client payload; nothing the browser says is trusted. Returns cleaned values or the first error.
 */
import { normalizeKeywords } from "@/lib/seo-keywords";
import { isSafeImageUrl, isSafeRelativePath } from "@/lib/url-safety";
import { normalizeBaseUrl, normalizeCanonicalOverride, parseRobotsDirectives } from "@/lib/seo-rules";
import { validatePageSlug } from "@/lib/seo-pages";
import { validateRedirectDestination, validateRedirectSource, REDIRECT_STATUS_CODES } from "@/lib/redirect-rules";

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string };
type Raw = Record<string, unknown>;

const str = (v: unknown, max: number, label: string): Valid<string | null> => {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: `${label} must be text.` };
  const t = v.trim();
  if (t.length > max) return { ok: false, error: `${label} must be at most ${max} characters.` };
  return { ok: true, value: t || null };
};
const bool = (v: unknown) => v === true;

const imageUrl = (v: unknown, label: string): Valid<string | null> => {
  const s = str(v, 2000, label);
  if (!s.ok || !s.value) return s;
  if (!(isSafeImageUrl(s.value) || isSafeRelativePath(s.value))) return { ok: false, error: `${label} must be an http(s) URL or a site path.` };
  return s;
};

const keywords = (v: unknown): Valid<string[]> => {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.some((k) => typeof k !== "string")) return { ok: false, error: "Keywords must be a list of text values." };
  return { ok: true, value: normalizeKeywords(v as string[]) };
};

const directives = (v: unknown): Valid<string | null> => {
  const s = str(v, 300, "Robots directives");
  if (!s.ok || !s.value) return s;
  const p = parseRobotsDirectives(s.value);
  return p.ok ? { ok: true, value: p.value.normalized || null } : p;
};

const canonical = (v: unknown, origin: string): Valid<string | null> => {
  const s = str(v, 2000, "Canonical URL");
  if (!s.ok || !s.value) return s;
  return normalizeCanonicalOverride(s.value, origin);
};

/** Runs checks in order and returns the first failure (so the admin sees one clear message). */
function all<T extends Record<string, Valid<unknown>>>(checks: T): Valid<{ [K in keyof T]: T[K] extends Valid<infer V> ? V : never }> {
  const out: Record<string, unknown> = {};
  for (const [k, r] of Object.entries(checks)) {
    if (!r.ok) return { ok: false, error: r.error };
    out[k] = r.value;
  }
  return { ok: true, value: out as { [K in keyof T]: T[K] extends Valid<infer V> ? V : never } };
}

/* -------------------------------------------------------------- global */

export type GlobalSeoValues = {
  seoDefaultTitle: string | null; seoTitleTemplate: string | null; seoDescription: string | null; seoKeywords: string[];
  seoOgTitle: string | null; seoOgDescription: string | null; ogImageUrl: string | null; seoTwitterCard: "summary" | "summary_large_image";
  seoCanonicalBaseUrl: string | null; seoDefaultNoIndex: boolean; seoDefaultNoFollow: boolean; seoRobotsExtra: string | null;
  seoOrgSchemaEnabled: boolean; seoWebsiteSchemaEnabled: boolean;
};

export function validateGlobalSeo(raw: Raw): Valid<GlobalSeoValues> {
  const template = str(raw.seoTitleTemplate, 120, "Title template");
  if (template.ok && template.value && !template.value.includes("%s")) return { ok: false, error: "The title template must contain %s where the page title goes (e.g. %s | Gift Pacific)." };
  const card = raw.seoTwitterCard === "summary" ? "summary" : "summary_large_image";
  const extra = str(raw.seoRobotsExtra, 2000, "Extra robots.txt rules");
  const r = all({
    seoDefaultTitle: str(raw.seoDefaultTitle, 120, "Default title"),
    seoTitleTemplate: template,
    seoDescription: str(raw.seoDescription, 320, "Default description"),
    seoKeywords: keywords(raw.seoKeywords),
    seoOgTitle: str(raw.seoOgTitle, 120, "Default OG title"),
    seoOgDescription: str(raw.seoOgDescription, 320, "Default OG description"),
    ogImageUrl: imageUrl(raw.ogImageUrl, "Default OG image"),
    seoCanonicalBaseUrl: normalizeBaseUrl(typeof raw.seoCanonicalBaseUrl === "string" ? raw.seoCanonicalBaseUrl : ""),
    seoRobotsExtra: extra,
  });
  if (!r.ok) return r;
  return { ok: true, value: { ...r.value, seoTwitterCard: card, seoDefaultNoIndex: bool(raw.seoDefaultNoIndex), seoDefaultNoFollow: bool(raw.seoDefaultNoFollow), seoOrgSchemaEnabled: raw.seoOrgSchemaEnabled !== false, seoWebsiteSchemaEnabled: raw.seoWebsiteSchemaEnabled !== false } };
}

/* ---------------------------------------------------------- page SEO */

export type PageSeoValues = {
  title: string | null; description: string | null; keywords: string[]; canonicalUrl: string | null; ogTitle: string | null;
  ogDescription: string | null; ogImage: string | null; noIndex: boolean; noFollow: boolean; robotsDirectives: string | null;
};

export function validatePageSeo(raw: Raw, origin: string): Valid<PageSeoValues> {
  const r = all({
    title: str(raw.title, 120, "SEO title"),
    description: str(raw.description, 320, "Meta description"),
    keywords: keywords(raw.keywords),
    canonicalUrl: canonical(raw.canonicalUrl, origin),
    ogTitle: str(raw.ogTitle, 120, "OG title"),
    ogDescription: str(raw.ogDescription, 320, "OG description"),
    ogImage: imageUrl(raw.ogImage, "OG image"),
    robotsDirectives: directives(raw.robotsDirectives),
  });
  return r.ok ? { ok: true, value: { ...r.value, noIndex: bool(raw.noIndex), noFollow: bool(raw.noFollow) } } : r;
}

/* ------------------------------------------- product/category/box SEO */

export type EntitySeoValues = { title: string | null; description: string | null; keywords: string[]; image: string | null; noindex: boolean; canonical: string | null };

export function validateEntitySeo(raw: Raw, origin: string): Valid<EntitySeoValues> {
  const r = all({
    title: str(raw.title, 120, "SEO title"),
    description: str(raw.description, 300, "Meta description"),
    keywords: keywords(raw.keywords),
    image: imageUrl(raw.image, "OG image"),
    canonical: canonical(raw.canonical, origin),
  });
  return r.ok ? { ok: true, value: { ...r.value, noindex: bool(raw.noindex) } } : r;
}

/* ------------------------------------------------------ static pages */

export type StaticPageValues = {
  slug: string; title: string; content: string; isPublished: boolean; sortOrder: number; showInFooter: boolean;
  seoTitle: string | null; seoDescription: string | null; seoKeywords: string[]; canonicalUrl: string | null; ogImage: string | null;
  noIndex: boolean; noFollow: boolean; robotsDirectives: string | null;
};

/** `sanitize` is injected (the HTML sanitizer) so this file stays dependency-free. `system` pages keep their fixed slug. */
export function validateStaticPage(raw: Raw, origin: string, sanitize: (html: string) => string, system?: { slug: string }): Valid<StaticPageValues> {
  let slug: string;
  if (system) slug = system.slug;
  else {
    const s = validatePageSlug(typeof raw.slug === "string" ? raw.slug : "");
    if (!s.ok) return { ok: false, error: s.error };
    slug = s.slug;
  }
  const title = str(raw.title, 160, "Title");
  if (!title.ok) return title;
  if (!title.value) return { ok: false, error: "A title is required." };
  const content = typeof raw.content === "string" ? raw.content : "";
  if (content.length > 200_000) return { ok: false, error: "The content is too long." };
  const sort = Number(raw.sortOrder ?? 0);
  if (!Number.isInteger(sort) || sort < -10000 || sort > 10000) return { ok: false, error: "Order must be a whole number." };
  const r = all({
    seoTitle: str(raw.seoTitle, 120, "SEO title"),
    seoDescription: str(raw.seoDescription, 320, "Meta description"),
    seoKeywords: keywords(raw.seoKeywords),
    canonicalUrl: canonical(raw.canonicalUrl, origin),
    ogImage: imageUrl(raw.ogImage, "OG image"),
    robotsDirectives: directives(raw.robotsDirectives),
  });
  if (!r.ok) return r;
  const html = sanitize(content);
  const isPublished = bool(raw.isPublished);
  if (isPublished && !html.replace(/<[^>]*>/g, "").trim()) return { ok: false, error: "Add some content before publishing this page." };
  return { ok: true, value: { ...r.value, slug, title: title.value, content: html, isPublished, sortOrder: sort, showInFooter: bool(raw.showInFooter), noIndex: bool(raw.noIndex), noFollow: bool(raw.noFollow) } };
}

/* ---------------------------------------------------------- redirects */

export type RedirectValues = { fromPath: string; toPath: string; statusCode: 301 | 302; isActive: boolean };

export function validateRedirect(raw: Raw, origin: string): Valid<RedirectValues> {
  const from = validateRedirectSource(typeof raw.fromPath === "string" ? raw.fromPath : "");
  if (!from.ok) return { ok: false, error: from.error };
  const to = validateRedirectDestination(typeof raw.toPath === "string" ? raw.toPath : "", origin);
  if (!to.ok) return { ok: false, error: to.error };
  const status = Number(raw.statusCode);
  if (!(REDIRECT_STATUS_CODES as readonly number[]).includes(status)) return { ok: false, error: "Choose 301 (permanent) or 302 (temporary)." };
  const toPathOnly = to.value.split(/[?#]/)[0];
  if (toPathOnly === from.value) return { ok: false, error: "The old and new path are the same." };
  return { ok: true, value: { fromPath: from.value, toPath: to.value, statusCode: status as 301 | 302, isActive: raw.isActive !== false } };
}
