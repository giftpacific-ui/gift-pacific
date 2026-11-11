import { test } from "node:test";
import assert from "node:assert/strict";
import { shopSeo } from "../../src/lib/seo-shop";

const site = "https://example.com/";
test("clean listing and category are indexable with a clean canonical", () => {
  assert.deepEqual(shopSeo({ siteUrl: site, path: [], query: {}, categoryFound: true }), { canonical: "https://example.com/shop", robots: { index: true, follow: true } });
  assert.equal(shopSeo({ siteUrl: site, path: ["mugs"], query: {}, categoryFound: true }).canonical, "https://example.com/shop/mugs");
});
test("filters, sorting and search are noindex and canonicalise to the clean listing", () => {
  for (const q of [{ sort: "price" }, { minPrice: "100" }, { kind: "combo" }, { q: "mug", page: "2" }]) {
    const r = shopSeo({ siteUrl: site, path: ["mugs"], query: q, categoryFound: true });
    assert.equal(r.robots.index, false);
    assert.equal(r.canonical, "https://example.com/shop/mugs");
  }
});
test("plain pagination keeps its own canonical and stays indexable; page 1 canonicalises to the base", () => {
  assert.equal(shopSeo({ siteUrl: site, path: [], query: { page: "3" }, categoryFound: true }).canonical, "https://example.com/shop?page=3");
  assert.equal(shopSeo({ siteUrl: site, path: [], query: { page: "1" }, categoryFound: true }).canonical, "https://example.com/shop");
  assert.equal(shopSeo({ siteUrl: site, path: [], query: { page: "3" }, categoryFound: true }).robots.index, true);
});
test("unknown categories are never indexed", () => {
  assert.equal(shopSeo({ siteUrl: site, path: ["nope"], query: {}, categoryFound: false }).robots.index, false);
});
