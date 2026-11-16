import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Metadata } from "next";
import { freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { pageMetadata } from "@/server/services/seo.service";
import { getPageSitemapEntries } from "@/server/services/sitemap.service";
import { getPublishedSystemPage } from "@/server/services/static-page.service";

/** Regression tests for the P2 audit fixes: (1) CMS SEO on built-in pages, (2) sitemap consistency. */
let db: FakeDb;
const O = "https://shop.example.com";
const titleOf = (m: Metadata) => (typeof m.title === "string" ? m.title : ((m.title as { absolute?: string } | null | undefined)?.absolute ?? ""));
const robotsOf = (m: Metadata) => m.robots as { index: boolean; follow: boolean };
const meta = () => pageMetadata({ title: "About us", description: "Built-in description", path: "/about-us" });

beforeEach(() => {
  db = freshDb();
  db.insert("storeSettings", { id: "singleton", seoCanonicalBaseUrl: O, seoDescription: "Global description" });
  db.insert("product", { id: "anchor", name: "anchor", slug: "anchor", status: "ACTIVE", isBoxProduct: false, seoNoIndex: false, seoCanonicalUrl: null });
});

const cms = (extra: Record<string, unknown> = {}) =>
  db.insert("staticPage", { id: "cms-about", slug: "about-us", systemKey: "about-us", title: "About", content: "<p>Replacement text</p>", isPublished: true, noIndex: false, noFollow: false, canonicalUrl: null, seoTitle: null, seoDescription: null, seoKeywords: [], ogImage: null, robotsDirectives: null, sortOrder: 0, ...extra });

/* ---------------------------------------------------------------- 1 */

test("built-in page SEO: with no replacement, the built-in text and Page SEO apply (unchanged behaviour)", async () => {
  const none = await meta();
  assert.match(titleOf(none), /About us/);
  assert.equal(none.description, "Built-in description");
  db.insert("pageSeo", { id: "ps", key: "about-us", title: "PageSeo About", description: "PageSeo description", noIndex: false, keywords: [] });
  const withPs = await meta();
  assert.match(titleOf(withPs), /PageSeo About/);
  assert.equal(withPs.description, "PageSeo description");
});

test("built-in page SEO: a published replacement's SEO fields win, blank ones fall back to Page SEO, noindex/canonical apply", async () => {
  db.insert("pageSeo", { id: "ps", key: "about-us", title: "PageSeo About", description: "PageSeo description", noIndex: false, keywords: [] });
  cms({ seoTitle: "CMS About", noIndex: true, canonicalUrl: "/contact" });
  const m = await meta();
  assert.match(titleOf(m), /CMS About/);
  assert.doesNotMatch(titleOf(m), /PageSeo About/);
  assert.equal(m.description, "PageSeo description", "blank CMS description falls through to Page SEO");
  assert.equal(robotsOf(m).index, false);
  assert.equal(m.alternates?.canonical, `${O}/contact`);
});

test("built-in page SEO: page-level noindex from Page SEO still applies, and a global fallback still fills gaps", async () => {
  db.insert("pageSeo", { id: "ps", key: "about-us", noIndex: true, keywords: [] });
  cms();
  const m = await pageMetadata({ title: "About us", path: "/about-us" });
  assert.equal(robotsOf(m).index, false);
  assert.equal(m.description, "Global description");
});

test("built-in page SEO: unpublished, empty or deleted replacement restores normal Page SEO behaviour", async () => {
  db.insert("pageSeo", { id: "ps", key: "about-us", title: "PageSeo About", noIndex: false, keywords: [] });
  const row = cms({ seoTitle: "CMS About", noIndex: true });
  assert.equal(robotsOf(await meta()).index, false);

  await db.staticPage.update({ where: { id: row.id }, data: { isPublished: false } });
  assert.equal(await getPublishedSystemPage("about-us"), null);
  let m = await meta();
  assert.match(titleOf(m), /PageSeo About/);
  assert.equal(robotsOf(m).index, true);

  await db.staticPage.update({ where: { id: row.id }, data: { isPublished: true, content: "<p>   </p>" } });
  m = await meta();
  assert.match(titleOf(m), /PageSeo About/, "published but empty content is not a replacement: built-in page + its SEO");
  assert.equal(robotsOf(m).index, true);

  await db.staticPage.update({ where: { id: row.id }, data: { content: "<p>Back</p>" } });
  assert.match(titleOf(await meta()), /CMS About/);
  await db.staticPage.delete({ where: { id: row.id } });
  m = await meta();
  assert.match(titleOf(m), /PageSeo About/);
  assert.equal(robotsOf(m).index, true);
});

test("explicit overrides (product/category/box/CMS custom pages) are untouched by the built-in-page merge", async () => {
  cms({ seoTitle: "CMS About" });
  const m = await pageMetadata({ title: "X", path: "/about-us" }, { override: { title: "Explicit" } });
  assert.match(titleOf(m), /Explicit/);
});

/* ---------------------------------------------------------------- 2 */

const urls = async () => (await getPageSitemapEntries()).map((e) => e.url);

test("sitemap: a published replacement with noindex removes the built-in URL", async () => {
  assert.ok((await urls()).includes(`${O}/about-us`));
  cms({ noIndex: true });
  assert.ok(!(await urls()).includes(`${O}/about-us`));
});

test("sitemap: a replacement canonical pointing elsewhere removes the URL; a self canonical keeps it once", async () => {
  const row = cms({ canonicalUrl: "/contact" });
  assert.ok(!(await urls()).includes(`${O}/about-us`));
  await db.staticPage.update({ where: { id: row.id }, data: { canonicalUrl: `${O}/about-us/` } });
  const list = await urls();
  assert.equal(list.filter((u) => u === `${O}/about-us`).length, 1);
});

test("sitemap: unpublished or empty replacement's noindex is ignored (the built-in page is what is served)", async () => {
  const row = cms({ noIndex: true, isPublished: false });
  assert.ok((await urls()).includes(`${O}/about-us`));
  await db.staticPage.update({ where: { id: row.id }, data: { isPublished: true, content: "" } });
  assert.ok((await urls()).includes(`${O}/about-us`));
});

test("sitemap: Page SEO noindex/canonical still apply, sitemap never lists a URL twice, ordinary CMS pages behave as before", async () => {
  db.insert("pageSeo", { id: "ps", key: "privacy", noIndex: true, keywords: [] });
  db.insert("staticPage", { id: "o1", slug: "gift-guide", systemKey: null, title: "G", content: "<p>x</p>", isPublished: true, noIndex: false, canonicalUrl: null, sortOrder: 0, seoKeywords: [] });
  db.insert("staticPage", { id: "o2", slug: "hidden", systemKey: null, title: "H", content: "<p>x</p>", isPublished: true, noIndex: true, canonicalUrl: null, sortOrder: 1, seoKeywords: [] });
  db.insert("staticPage", { id: "o3", slug: "moved", systemKey: null, title: "M", content: "<p>x</p>", isPublished: true, noIndex: false, canonicalUrl: "/contact", sortOrder: 2, seoKeywords: [] });
  cms();
  const list = await urls();
  assert.ok(!list.includes(`${O}/privacy`));
  assert.ok(list.includes(`${O}/pages/gift-guide`));
  assert.ok(!list.includes(`${O}/pages/hidden`) && !list.includes(`${O}/pages/moved`));
  assert.equal(new Set(list).size, list.length);
});
