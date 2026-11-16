import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPageMetadata, absoluteUrl } from "@/lib/seo";
import { organizationJsonLd, websiteJsonLd, breadcrumbJsonLd, webPageJsonLd } from "@/lib/structured-data";

const O = "https://shop.example.com";

test("metadata: canonical is absolute, trailing-slash free and uses the configured origin", () => {
  const m = buildPageMetadata({ title: "Contact", path: "/contact/", origin: O });
  assert.equal(m.alternates?.canonical, `${O}/contact`);
  assert.equal(absoluteUrl("/", O), O);
});

test("metadata: a same-site canonical override is honoured, a foreign one is ignored (never conflicting)", () => {
  assert.equal(buildPageMetadata({ title: "A", path: "/a", origin: O, canonicalOverride: "/b/" }).alternates?.canonical, `${O}/b`);
  assert.equal(buildPageMetadata({ title: "A", path: "/a", origin: O, canonicalOverride: "https://evil.com/x" }).alternates?.canonical, `${O}/a`);
});

test("metadata: robots reflect index/follow switches and safe directives only", () => {
  assert.deepEqual(buildPageMetadata({ title: "A", path: "/a", origin: O }).robots, { index: true, follow: true });
  assert.deepEqual(buildPageMetadata({ title: "A", path: "/a", origin: O, noindex: true, nofollow: true, robotsDirectives: "noarchive" }).robots, { index: false, follow: false, noarchive: true });
  assert.deepEqual(buildPageMetadata({ title: "A", path: "/a", origin: O, robotsDirectives: "noindex,<x>" }).robots, { index: true, follow: true });
});

test("metadata: OG overrides apply to Open Graph only; Twitter card needs an image for the large type", () => {
  const m = buildPageMetadata({ title: "Page", description: "Search desc", path: "/p", origin: O, ogTitle: "Share title", ogDescription: "Share desc", image: "https://img.example.com/a.jpg" });
  assert.equal(m.openGraph?.title, "Share title");
  assert.equal(m.openGraph?.description, "Share desc");
  assert.equal(m.description, "Search desc");
  assert.equal((m.twitter as { card: string }).card, "summary_large_image");
  const noImg = buildPageMetadata({ title: "Page", path: "/p", origin: O, twitterCard: "summary_large_image" });
  assert.equal((noImg.twitter as { card: string }).card, "summary");
  const small = buildPageMetadata({ title: "Page", path: "/p", origin: O, image: "https://img.example.com/a.jpg", twitterCard: "summary" });
  assert.equal((small.twitter as { card: string }).card, "summary");
});

test("structured data: valid shapes, real values only, configured origin, no invented ratings", () => {
  const org = organizationJsonLd({ storeName: "Gift Pacific", storeEmail: "a@b.co" }, O) as Record<string, unknown>;
  assert.equal(org["@type"], "Organization");
  assert.equal(org["@id"], `${O}/#organization`);
  assert.ok(!("aggregateRating" in org));
  const site = websiteJsonLd("Gift Pacific", O) as Record<string, unknown>;
  assert.equal(site.url, O);
  const crumbs = breadcrumbJsonLd([{ name: "Home", path: "/" }, { name: "Guide", path: "/pages/guide" }], O) as { itemListElement: { position: number; item: string }[] };
  assert.deepEqual(crumbs.itemListElement.map((c) => [c.position, c.item]), [[1, O], [2, `${O}/pages/guide`]]);
  const page = webPageJsonLd({ name: "Guide", path: "/pages/guide", origin: O, datePublished: new Date("2026-01-02T00:00:00Z") }) as Record<string, unknown>;
  assert.equal(page["@type"], "WebPage");
  assert.equal(page.url, `${O}/pages/guide`);
  assert.equal(page.datePublished, "2026-01-02T00:00:00.000Z");
  assert.ok(!("dateModified" in page) && !("description" in page));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify([org, site, crumbs, page])));
});
