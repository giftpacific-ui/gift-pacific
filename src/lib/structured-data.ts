import { siteConfig } from "@/config/site";
import { absoluteUrl, clampText, safeImageUrl, siteOrigin } from "@/lib/seo";

/** Plain-object builders for schema.org JSON-LD. Render with <JsonLd/>, which serializes safely (see lib/json-ld.ts). */

type Json = Record<string, unknown>;

export type OrgSettings = {
  storeName?: string | null;
  storeEmail?: string | null;
  storePhone?: string | null;
  storeAddress?: string | null;
  logoUrl?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  tiktokUrl?: string | null;
};

function httpOnly(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function organizationJsonLd(s: OrgSettings): Json {
  const sameAs = [s.facebookUrl, s.instagramUrl, s.tiktokUrl].map(httpOnly).filter((u): u is string => !!u);
  const logo = safeImageUrl(s.logoUrl) ?? safeImageUrl(siteConfig.logoUrl);
  const contact =
    s.storeEmail || s.storePhone
      ? [
          {
            "@type": "ContactPoint",
            contactType: "customer service",
            ...(s.storeEmail ? { email: s.storeEmail } : {}),
            ...(s.storePhone ? { telephone: s.storePhone } : {}),
            areaServed: "BD",
          },
        ]
      : undefined;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${siteOrigin()}/#organization`,
    name: s.storeName || siteConfig.name,
    url: siteOrigin(),
    ...(logo ? { logo } : {}),
    ...(contact ? { contactPoint: contact } : {}),
    ...(s.storeAddress ? { address: { "@type": "PostalAddress", streetAddress: s.storeAddress, addressCountry: "BD" } } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
  };
}

/** Storefront search is `/search?q=…` (a GET form), so the SearchAction below is accurate. */
export function websiteJsonLd(name: string): Json {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${siteOrigin()}/#website`,
    name,
    url: siteOrigin(),
    publisher: { "@id": `${siteOrigin()}/#organization` },
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${siteOrigin()}/search?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}

export type Crumb = { name: string; path: string };

export function breadcrumbJsonLd(crumbs: Crumb[]): Json {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: absoluteUrl(c.path) })),
  };
}

export type ProductLd = {
  name: string;
  description: string;
  path: string;
  images: string[];
  sku?: string | null;
  brand?: string | null;
  currency: string;
  /** Display price; for variant products, the lowest purchasable price. */
  price: number;
  /** Highest variant price, only for products with several distinct variant prices. */
  highPrice?: number | null;
  offerCount?: number | null;
  availability: string;
  reviews: { rating: number; title: string | null; body: string | null; createdAt: Date; reviewerName: string }[];
};

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export function productJsonLd(p: ProductLd): Json {
  const url = absoluteUrl(p.path);
  const images = p.images.map(safeImageUrl).filter((u): u is string => !!u);
  const multi = p.highPrice != null && p.highPrice > p.price;
  const offers: Json = multi
    ? {
        "@type": "AggregateOffer",
        priceCurrency: p.currency,
        lowPrice: money(p.price),
        highPrice: money(p.highPrice as number),
        ...(p.offerCount ? { offerCount: p.offerCount } : {}),
        availability: p.availability,
        url,
      }
    : { "@type": "Offer", priceCurrency: p.currency, price: money(p.price), availability: p.availability, itemCondition: "https://schema.org/NewCondition", url };

  // Only genuine, published reviews are ever passed in; nothing is synthesised.
  const rated = p.reviews.filter((r) => Number.isFinite(r.rating) && r.rating >= 1 && r.rating <= 5);
  const average = rated.length > 0 ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : null;

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(images.length > 0 ? { image: images } : {}),
    ...(p.sku ? { sku: p.sku } : {}),
    ...(p.brand ? { brand: { "@type": "Brand", name: p.brand } } : {}),
    url,
    offers,
    ...(average !== null
      ? {
          aggregateRating: { "@type": "AggregateRating", ratingValue: average.toFixed(1), reviewCount: rated.length, bestRating: 5, worstRating: 1 },
          review: rated.slice(0, 5).map((r) => ({
            "@type": "Review",
            reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5, worstRating: 1 },
            author: { "@type": "Person", name: r.reviewerName },
            datePublished: r.createdAt.toISOString().slice(0, 10),
            ...(r.title ? { name: clampText(r.title, 110) } : {}),
            ...(r.body ? { reviewBody: clampText(r.body, 500) } : {}),
          })),
        }
      : {}),
  };
}

/** For category / campaign listings. The ItemList mirrors products actually shown on the page. */
export function collectionPageJsonLd(i: { name: string; description?: string | null; path: string; items?: { name: string; path: string }[] }): Json {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: i.name,
    url: absoluteUrl(i.path),
    ...(i.description ? { description: clampText(i.description, 300) } : {}),
    ...(i.items && i.items.length > 0
      ? {
          mainEntity: {
            "@type": "ItemList",
            itemListElement: i.items.map((it, n) => ({ "@type": "ListItem", position: n + 1, url: absoluteUrl(it.path), name: it.name })),
          },
        }
      : {}),
  };
}
