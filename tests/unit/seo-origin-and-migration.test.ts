import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { productJsonLd, collectionPageJsonLd, breadcrumbJsonLd, organizationJsonLd, websiteJsonLd, webPageJsonLd } from "@/lib/structured-data";
import { buildPageMetadata } from "@/lib/seo";
import { shopSeo } from "@/lib/seo-shop";

/** Regression: (3) one canonical origin everywhere, (4) migration/schema agreement. */
const O = "https://configured.example.com";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const flat = (v: unknown) => JSON.stringify(v);

test("every JSON-LD builder emits URLs on the configured origin when one is passed", () => {
  const product = productJsonLd({ origin: O, name: "Mug", path: "/products/mug", images: [], currency: "BDT", price: 100, availability: "https://schema.org/InStock", reviews: [] } as never);
  const collection = collectionPageJsonLd({ origin: O, name: "Mugs", path: "/shop/mugs", items: [{ name: "Mug", path: "/products/mug" }] });
  const crumbs = breadcrumbJsonLd([{ name: "Home", path: "/" }, { name: "Mug", path: "/products/mug" }], O);
  const all = [product, collection, crumbs, organizationJsonLd({ storeName: "S" }, O), websiteJsonLd("S", O), webPageJsonLd({ name: "P", path: "/pages/p", origin: O })];
  for (const doc of all) {
    const urls = flat(doc).match(/https?:\/\/[^"\\]+/g) ?? [];
    // schema.org context / availability / itemCondition URLs are vocabulary, not site URLs.
    const site = urls.filter((u) => !u.startsWith("https://schema.org") && !u.startsWith("http://www.sitemaps"));
    assert.ok(site.length > 0, flat(doc).slice(0, 60));
    for (const u of site) assert.ok(u.startsWith(O), `${u} is not on ${O}`);
  }
  assert.equal((product as { url: string }).url, `${O}/products/mug`);
  assert.equal(((product as { offers: { url: string } }).offers).url, `${O}/products/mug`);
});

test("canonical tag, Open Graph URL, shop canonical and JSON-LD agree on one origin", () => {
  const meta = buildPageMetadata({ title: "Mug", path: "/products/mug", origin: O });
  const ld = productJsonLd({ origin: O, name: "Mug", path: "/products/mug", images: [], currency: "BDT", price: 1, availability: "https://schema.org/InStock", reviews: [] } as never) as { url: string };
  assert.equal(meta.alternates?.canonical, ld.url);
  assert.equal(meta.openGraph && (meta.openGraph as { url?: string }).url, ld.url);
  const shop = shopSeo({ siteUrl: O, path: ["mugs"], query: {}, categoryFound: true } as never);
  assert.ok(shop.canonical.startsWith(`${O}/shop/mugs`));
});

test("product and shop pages pass the configured origin (no bare env origin in their JSON-LD)", () => {
  const product = read("src/app/(shop)/products/[slug]/page.tsx");
  const shop = read("src/app/(shop)/shop/[[...category]]/page.tsx");
  assert.match(product, /const origin = await getCanonicalOrigin\(\)/);
  assert.match(product, /productJsonLd\(\{\s*origin,/);
  assert.match(product, /\], origin\),/, "breadcrumb receives the origin");
  assert.match(shop, /siteUrl: await getCanonicalOrigin\(\)/);
  assert.match(shop, /collectionPageJsonLd\(\{\s*origin,/);
  assert.match(shop, /\], origin\),/);
  assert.doesNotMatch(shop, /siteConfig\.url/);
});

test("follow-up migration aligns PageSeo.keywords / StaticPage.seoKeywords with the schema without touching the P2 migration", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model PageSeo \{[\s\S]*?keywords\s+String\[\]\s+@default\(\[\]\)/);
  assert.match(schema, /model StaticPage \{[\s\S]*?seoKeywords\s+String\[\]\s+@default\(\[\]\)/);

  const dirs = readdirSync(join(process.cwd(), "prisma/migrations")).filter((d) => /^\d{14}_/.test(d)).sort();
  const p2 = dirs.indexOf("20261120000000_seo_management_p2");
  const fix = dirs.indexOf("20261121000000_seo_keywords_not_null");
  assert.ok(p2 >= 0 && fix === p2 + 1 && fix === dirs.length - 1, "follow-up sorts directly after the P2 migration");

  const sql = read("prisma/migrations/20261121000000_seo_keywords_not_null/migration.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(sql, /\b(DROP|DELETE|TRUNCATE|INSERT)\b/i);
  for (const [table, col] of [["PageSeo", "keywords"], ["StaticPage", "seoKeywords"]]) {
    const backfill = sql.indexOf(`UPDATE "${table}" SET "${col}" = ARRAY[]::TEXT[] WHERE "${col}" IS NULL`);
    const notNull = sql.indexOf(`ALTER TABLE "${table}" ALTER COLUMN "${col}" SET NOT NULL`);
    assert.ok(backfill >= 0 && notNull > backfill, `${table}: NULLs are backfilled before NOT NULL`);
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ALTER COLUMN "${col}" SET DEFAULT ARRAY\\[\\]::TEXT\\[\\]`));
  }
  assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 2, "only the two NULL backfills");

  // The original P2 migration is unchanged (still the nullable form, so databases that already applied it keep a valid history).
  const p2sql = read("prisma/migrations/20261120000000_seo_management_p2/migration.sql");
  assert.match(p2sql, /"keywords" TEXT\[\] DEFAULT ARRAY\[\]::TEXT\[\],/);
  assert.match(p2sql, /"seoKeywords" TEXT\[\] DEFAULT ARRAY\[\]::TEXT\[\],/);
});
