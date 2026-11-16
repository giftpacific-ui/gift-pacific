/**
 * Pure SEO rules (no server/DB imports): canonical safety, robots directives, robots.txt rules, fallback resolution,
 * record audits and duplicate detection. Everything the admin can type is validated here, and everything that is
 * rendered is passed through here, so the behaviour is identical on save and on render and is unit-tested.
 */

export const TITLE_RECOMMENDED_MAX = 60;
export const DESCRIPTION_RECOMMENDED_MAX = 160;

/* ---------------------------------------------------------------- URLs */

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Website canonical base URL: an http(s) origin only (no path, query, hash or credentials). Empty → null (use the env default). */
export function normalizeBaseUrl(input: string | null | undefined): Checked<string | null> {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, value: null };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "Enter a full URL such as https://www.example.com." };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOST.test(u.host))) {
    return { ok: false, error: "The canonical base URL must start with https:// (http:// is only accepted for localhost)." };
  }
  if (u.username || u.password) return { ok: false, error: "The base URL must not contain credentials." };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { ok: false, error: "Use the site origin only, without a path, query string or #fragment." };
  return { ok: true, value: u.origin };
}

/** Normalised path: leading slash, no query/hash, no trailing slash (except "/"), no duplicate slashes. */
export function normalizePath(path: string): string {
  const p = path.split("#")[0].split("?")[0].replace(/\/{2,}/g, "/");
  const withSlash = p.startsWith("/") ? p : `/${p}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

/**
 * Canonical override: a site-relative path, or an absolute URL on the SAME host as `origin`. Query strings and
 * fragments are dropped (one page → one canonical). Anything else (other hosts, javascript:, //host, credentials) is rejected.
 * Returns the absolute canonical URL.
 */
export function normalizeCanonicalOverride(input: string | null | undefined, origin: string): Checked<string | null> {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, value: null };
  if (/[\s\u0000-\u001f]/.test(raw)) return { ok: false, error: "The canonical URL must not contain spaces or control characters." };
  if (raw.includes("\\")) return { ok: false, error: "Backslashes are not allowed in a canonical URL." };
  if (raw.startsWith("//")) return { ok: false, error: "Protocol-relative URLs are not allowed." };
  if (raw.startsWith("/")) {
    const path = normalizePath(raw);
    return { ok: true, value: path === "/" ? origin : `${origin}${path}` };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "Enter a path such as /about-us or a full URL on this site." };
  }
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return { ok: false, error: "The site origin is not configured correctly." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Only http(s) URLs are allowed." };
  if (u.username || u.password) return { ok: false, error: "The canonical URL must not contain credentials." };
  if (u.host.toLowerCase() !== base.host.toLowerCase()) return { ok: false, error: `The canonical URL must be on ${base.host}. Cross-domain canonicals are not supported.` };
  const path = normalizePath(u.pathname);
  return { ok: true, value: path === "/" ? origin : `${origin}${path}` };
}

/** Absolute URL for a path on `origin`, with one canonical spelling (no trailing slash, except the bare origin). */
export function joinOrigin(origin: string, path: string): string {
  const p = normalizePath(path);
  return p === "/" ? origin : `${origin}${p}`;
}

/* ------------------------------------------------------- robots meta */

export type RobotsMeta = {
  index: boolean;
  follow: boolean;
  noarchive?: boolean;
  nosnippet?: boolean;
  noimageindex?: boolean;
  notranslate?: boolean;
  "max-snippet"?: number;
  "max-image-preview"?: "none" | "standard" | "large";
  "max-video-preview"?: number;
};

const FLAG_DIRECTIVES = new Set(["noarchive", "nosnippet", "noimageindex", "notranslate"]);
const CONFLICTING = new Set(["index", "noindex", "follow", "nofollow", "none", "all"]);

export type ParsedDirectives = { flags: Partial<RobotsMeta>; normalized: string };

/**
 * Optional custom robots directives (comma separated). Only a safe allowlist is accepted. index/noindex/follow/nofollow
 * are NOT accepted here (they have their own switches) so a page can never end up with contradicting instructions.
 */
export function parseRobotsDirectives(input: string | null | undefined): Checked<ParsedDirectives> {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, value: { flags: {}, normalized: "" } };
  const flags: Partial<RobotsMeta> = {};
  const out: string[] = [];
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (CONFLICTING.has(part)) return { ok: false, error: `"${part}" is controlled by the Index/Follow switches; remove it from the custom directives.` };
    if (FLAG_DIRECTIVES.has(part)) {
      (flags as Record<string, boolean>)[part] = true;
      if (!out.includes(part)) out.push(part);
      continue;
    }
    const m = /^(max-snippet|max-video-preview):(-?\d{1,6})$/.exec(part);
    if (m) {
      const n = Number(m[2]);
      if (n < -1) return { ok: false, error: `${m[1]} must be -1 or greater.` };
      (flags as Record<string, number>)[m[1]] = n;
      out.push(`${m[1]}:${n}`);
      continue;
    }
    const img = /^max-image-preview:(none|standard|large)$/.exec(part);
    if (img) {
      flags["max-image-preview"] = img[1] as "none" | "standard" | "large";
      out.push(part);
      continue;
    }
    return { ok: false, error: `Unsupported directive "${part}". Allowed: noarchive, nosnippet, noimageindex, notranslate, max-snippet:N, max-image-preview:none|standard|large, max-video-preview:N.` };
  }
  return { ok: true, value: { flags, normalized: out.join(", ") } };
}

export type RobotsInput = {
  noindex?: boolean | null;
  nofollow?: boolean | null;
  directives?: string | null;
};

/** Final robots meta: index/follow from the switches, plus validated custom directives (invalid stored text is ignored, never emitted). */
export function buildRobotsMeta(i: RobotsInput): RobotsMeta {
  const parsed = parseRobotsDirectives(i.directives);
  return { index: !i.noindex, follow: !i.nofollow, ...(parsed.ok ? parsed.value.flags : {}) };
}

/** Same result as a header-style string, e.g. "noindex, follow, noarchive" (used by previews and the audit). */
export function robotsMetaToString(m: RobotsMeta): string {
  const parts = [m.index ? "index" : "noindex", m.follow ? "follow" : "nofollow"];
  for (const f of FLAG_DIRECTIVES) if ((m as Record<string, unknown>)[f]) parts.push(f);
  if (m["max-snippet"] !== undefined) parts.push(`max-snippet:${m["max-snippet"]}`);
  if (m["max-image-preview"]) parts.push(`max-image-preview:${m["max-image-preview"]}`);
  if (m["max-video-preview"] !== undefined) parts.push(`max-video-preview:${m["max-video-preview"]}`);
  return parts.join(", ");
}

/* ------------------------------------------------------ robots.txt */

/** Private / non-content areas that are always disallowed and never listed in a sitemap. */
export const PRIVATE_PATHS = ["/admin", "/account", "/cart", "/checkout", "/login", "/register", "/forgot-password", "/reset-password", "/search", "/docs", "/api/"] as const;

/** Public routes that robots.txt must never block, whatever an admin types. */
export const ESSENTIAL_PREFIXES = ["/shop", "/products", "/boxes", "/campaign", "/about-us", "/contact", "/pages", "/privacy", "/terms", "/shipping-returns", "/build-your-own-combo", "/career", "/_next", "/sitemap", "/sitemap.xml", "/images", "/img"] as const;

export type RobotsTxtRules = { disallow: string[]; rejected: { line: string; reason: string }[] };

/**
 * Admin "extra rules": one `Disallow: /path` per line (the prefix is optional). Lines that would block an essential
 * public route, use wildcards, or are not simple paths are rejected with a reason and are NOT emitted.
 */
export function buildRobotsTxtRules(extra: string | null | undefined): RobotsTxtRules {
  const disallow: string[] = [...PRIVATE_PATHS];
  const rejected: { line: string; reason: string }[] = [];
  for (const rawLine of (extra ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:disallow\s*:\s*)?(\S+)$/i.exec(line);
    if (!m) { rejected.push({ line, reason: "Not a simple path (use one path per line)." }); continue; }
    const path = m[1];
    if (!path.startsWith("/")) { rejected.push({ line, reason: "A path must start with /." }); continue; }
    if (path === "/") { rejected.push({ line, reason: "Blocking / would hide the whole site." }); continue; }
    if (/[*$?]/.test(path)) { rejected.push({ line, reason: "Wildcards and query patterns are not supported." }); continue; }
    const hit = ESSENTIAL_PREFIXES.find((e) => e === path || e.startsWith(path.endsWith("/") ? path : `${path}`) || path.startsWith(`${e}/`) || path === e);
    if (hit) { rejected.push({ line, reason: `Would block the public route ${hit}.` }); continue; }
    if (!disallow.includes(path)) disallow.push(path);
  }
  return { disallow, rejected };
}

/* -------------------------------------------- fallback resolution */

/**
 * Field-by-field merge of SEO overrides, highest priority first. A blank/empty value never wins over a later non-blank one
 * (so an unset CMS field falls through to Page SEO); `noIndex`/`noFollow` are ORed (either source can hide a page, neither can unhide it).
 */
export function mergeSeoOverrides(...layers: (SeoOverride | null | undefined)[]): SeoOverride {
  const out: SeoOverride = {};
  const strKeys = ["title", "description", "canonicalUrl", "ogTitle", "ogDescription", "ogImage", "robotsDirectives"] as const;
  for (const k of strKeys) {
    const hit = layers.map((l) => (l?.[k] ?? "").trim()).find(Boolean);
    if (hit) out[k] = hit;
  }
  const kw = layers.find((l) => l?.keywords?.length)?.keywords;
  if (kw) out.keywords = kw;
  out.noIndex = layers.some((l) => l?.noIndex);
  out.noFollow = layers.some((l) => l?.noFollow);
  return out;
}


export type GlobalSeo = {
  defaultTitle?: string | null;
  description?: string | null;
  keywords?: string[] | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  twitterCard?: string | null;
  defaultNoIndex?: boolean | null;
  defaultNoFollow?: boolean | null;
};

export type SeoOverride = {
  title?: string | null;
  description?: string | null;
  keywords?: string[] | null;
  canonicalUrl?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  noIndex?: boolean | null;
  noFollow?: boolean | null;
  robotsDirectives?: string | null;
};

const text = (v: string | null | undefined) => (v ?? "").trim() || undefined;

/**
 * Precedence for every field: admin override on the page → the route's own data-derived default → global setting.
 * `noindex` is the OR of page and global default (a global "noindex" is a deliberate site-wide switch, e.g. for staging);
 * a page cannot opt back in because that would silently leak a hidden site.
 */
export function resolveSeoFields(
  override: SeoOverride | null | undefined,
  routeDefault: { title?: string | null; description?: string | null; keywords?: string[] | null; image?: string | null; noindex?: boolean | null },
  global: GlobalSeo,
) {
  const o = override ?? {};
  const title = text(o.title) ?? text(routeDefault.title) ?? text(global.defaultTitle);
  const description = text(o.description) ?? text(routeDefault.description) ?? text(global.description);
  const keywords = o.keywords?.length ? o.keywords : routeDefault.keywords?.length ? routeDefault.keywords : global.keywords?.length ? global.keywords : undefined;
  const image = text(o.ogImage) ?? text(routeDefault.image) ?? text(global.ogImage);
  return {
    title,
    titleFromOverride: !!text(o.title),
    description,
    keywords,
    ogTitle: text(o.ogTitle) ?? text(global.ogTitle),
    ogDescription: text(o.ogDescription) ?? text(global.ogDescription),
    image,
    canonicalOverride: text(o.canonicalUrl),
    noindex: !!(o.noIndex || routeDefault.noindex || global.defaultNoIndex),
    nofollow: !!(o.noFollow || global.defaultNoFollow),
    directives: text(o.robotsDirectives),
    twitterCard: global.twitterCard === "summary" ? ("summary" as const) : global.twitterCard === "summary_large_image" ? ("summary_large_image" as const) : undefined,
  };
}

/* ------------------------------------------------------- audits */

export type SeoRecord = {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  noindex?: boolean | null;
  canonical?: string | null;
  /** The record's own path, to detect a canonical that points to a different URL. */
  path?: string;
};

export type SeoIssueCode = "missing-title" | "missing-description" | "missing-image" | "noindex" | "invalid-canonical" | "canonical-elsewhere" | "long-title" | "long-description";

export function auditSeoRecord(r: SeoRecord, origin: string): SeoIssueCode[] {
  const issues: SeoIssueCode[] = [];
  const title = (r.title ?? "").trim();
  const desc = (r.description ?? "").trim();
  if (!title) issues.push("missing-title");
  else if (title.length > TITLE_RECOMMENDED_MAX + 10) issues.push("long-title");
  if (!desc) issues.push("missing-description");
  else if (desc.length > DESCRIPTION_RECOMMENDED_MAX + 20) issues.push("long-description");
  if (!(r.image ?? "").trim()) issues.push("missing-image");
  if (r.noindex) issues.push("noindex");
  if ((r.canonical ?? "").trim()) {
    const c = normalizeCanonicalOverride(r.canonical, origin);
    if (!c.ok) issues.push("invalid-canonical");
    else if (r.path && c.value && c.value !== joinOrigin(origin, r.path)) issues.push("canonical-elsewhere");
  }
  return issues;
}

/** Groups records that share the same (case-insensitive, trimmed) value. Only groups of 2+ are returned. */
export function findDuplicates<T extends { id: string }>(items: T[], pick: (i: T) => string | null | undefined): { value: string; ids: string[] }[] {
  const map = new Map<string, string[]>();
  for (const it of items) {
    const v = (pick(it) ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!v) continue;
    const list = map.get(v);
    if (list) list.push(it.id);
    else map.set(v, [it.id]);
  }
  return [...map.entries()].filter(([, ids]) => ids.length > 1).map(([value, ids]) => ({ value, ids }));
}

/** Should this URL be listed in a sitemap? Excludes private paths, noindex and records whose canonical points elsewhere. */
export function isSitemapEligible(r: { path: string; noindex?: boolean | null; canonical?: string | null }, origin: string): boolean {
  const path = normalizePath(r.path);
  if (r.noindex) return false;
  if (PRIVATE_PATHS.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p.endsWith("/") ? p : `${p}/`))) return false;
  if ((r.canonical ?? "").trim()) {
    const c = normalizeCanonicalOverride(r.canonical, origin);
    if (c.ok && c.value && c.value !== joinOrigin(origin, path)) return false;
  }
  return true;
}
