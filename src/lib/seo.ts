import type { Metadata } from "next";
import { siteConfig } from "@/config/site";
import { isSafeImageUrl } from "@/lib/url-safety";
import { stripHtml } from "@/lib/utils";

/**
 * The ONE place public-page metadata is assembled. Pages pass plain data; this file decides the title shape,
 * length limits, canonical URL, robots, Open Graph and Twitter output, so every page behaves the same way.
 */

export const DESCRIPTION_MAX = 160;
/** Search results show roughly this many characters of a title (the site-name suffix counts). */
export const TITLE_MAX = 60;

export function siteOrigin(): string {
  return siteConfig.url.replace(/\/+$/, "");
}

/** Absolute URL on the configured production origin. Always a path: never an arbitrary external address. */
export function absoluteUrl(path = "/"): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  // No trailing slash except the root, so one page never has two canonical spellings.
  const trimmed = clean.length > 1 ? clean.replace(/\/+$/, "") : clean;
  return `${siteOrigin()}${trimmed === "/" ? "" : trimmed}` || siteOrigin();
}

/** Collapses whitespace and cuts at a word boundary, adding an ellipsis only when something was removed. */
export function clampText(text: string | null | undefined, max: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/** First candidate with real text, with HTML removed. */
export function firstText(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    const t = c ? stripHtml(c).trim() : "";
    if (t) return t;
  }
  return "";
}

/** Only absolute http(s) URLs or site-relative paths survive; everything else is dropped. Returns an absolute URL. */
export function safeImageUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("/") && !url.startsWith("//")) return `${siteOrigin()}${url}`;
  return isSafeImageUrl(url) ? url : undefined;
}

/**
 * Social/search previews want a JPEG/PNG of reasonable size. For Cloudinary assets we ask for a capped, compressed
 * JPEG instead of the (possibly multi-megabyte) original; other hosts are used as stored.
 */
export function socialImageUrl(url: string | null | undefined): string | undefined {
  const safe = safeImageUrl(url);
  if (!safe) return undefined;
  const marker = "/image/upload/";
  if (safe.includes("res.cloudinary.com") && safe.includes(marker) && !safe.includes("/upload/c_limit,w_1200")) {
    return safe.replace(marker, `${marker}c_limit,w_1200,h_1200,q_auto,f_jpg/`);
  }
  return safe;
}

export type PageSeo = {
  /** Page-specific title WITHOUT the site name (the root template appends it). */
  title: string;
  description?: string | null;
  /** Path on this site, e.g. "/products/blue-mug". Becomes the canonical URL. */
  path: string;
  image?: string | null;
  imageAlt?: string | null;
  keywords?: string[];
  /** true → noindex,follow. */
  noindex?: boolean;
  /** When the admin typed the title, keep it exactly (only the site-name suffix logic applies). */
  titleIsCustom?: boolean;
  openGraphType?: "website" | "article";
};

function titleFor(seo: PageSeo): Metadata["title"] {
  const name = siteConfig.name;
  const base = seo.titleIsCustom ? seo.title.trim() : clampText(seo.title, Math.max(30, TITLE_MAX - name.length - 3));
  // Don't write "Gift Pacific | Gift Pacific": a title that already carries the brand is used as-is.
  return base.toLowerCase().includes(name.toLowerCase()) ? { absolute: base } : base;
}

function titleText(seo: PageSeo): string {
  const t = titleFor(seo);
  const base = typeof t === "string" ? t : (t as { absolute: string }).absolute;
  return typeof t === "string" ? `${base} | ${siteConfig.name}` : base;
}

export function buildPageMetadata(seo: PageSeo): Metadata {
  const canonical = absoluteUrl(seo.path);
  const description = clampText(seo.description || siteConfig.description, DESCRIPTION_MAX) || undefined;
  const image = socialImageUrl(seo.image);
  const ogTitle = titleText(seo);
  return {
    title: titleFor(seo),
    description,
    keywords: seo.keywords && seo.keywords.length > 0 ? seo.keywords : undefined,
    alternates: { canonical },
    robots: seo.noindex ? { index: false, follow: true } : { index: true, follow: true },
    openGraph: {
      type: seo.openGraphType ?? "website",
      title: ogTitle,
      description,
      url: canonical,
      siteName: siteConfig.name,
      images: image ? [{ url: image, alt: seo.imageAlt || seo.title }] : undefined,
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title: ogTitle,
      description,
      images: image ? [image] : undefined,
    },
  };
}

/** Pages that must never be indexed (cart, search, account areas): robots only, no canonical/OG work. */
export function noIndexMetadata(title: string): Metadata {
  return { title, robots: { index: false, follow: false } };
}

export const productPath = (slug: string) => `/products/${slug}`;
export const categoryPath = (slug: string) => `/shop/${slug}`;
