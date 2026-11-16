import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../setup/helpers";
import { getPageSitemapEntries, getProductSitemapEntries } from "@/server/services/sitemap.service";
import robots from "@/app/robots";
import { GET as sitemapIndex } from "@/app/sitemap-index/route";
import { findActiveRedirect, clearRedirectCache } from "@/server/services/redirect.service";
import type { FakeDb } from "../setup/fake-db";

let db: FakeDb;
const ORIGIN_RE = /^https?:\/\//;
beforeEach(() => {
  db = freshDb();
  db.insert("storeSettings", { id: "singleton", seoCanonicalBaseUrl: "https://shop.example.com" });
  clearRedirectCache();
});

const product = (id: string, extra: Record<string, unknown> = {}) =>
  db.insert("product", { id, name: id, slug: id, status: "ACTIVE", isBoxProduct: false, seoNoIndex: false, seoCanonicalUrl: null, ...extra });

test("product sitemap lists only active, indexable products whose canonical is themselves, on the configured origin", async () => {
  product("ok");
  product("self-canonical", { seoCanonicalUrl: "https://shop.example.com/products/self-canonical/" });
  product("hidden", { seoNoIndex: true });
  product("draft", { status: "DRAFT" });
  product("box-backing", { isBoxProduct: true });
  product("canonical-elsewhere", { seoCanonicalUrl: "/products/ok" });
  const urls = (await getProductSitemapEntries(0)).map((e) => e.url).sort();
  assert.deepEqual(urls, ["https://shop.example.com/products/ok", "https://shop.example.com/products/self-canonical"]);
});

test("page sitemap: honours Page SEO noindex, publishes only published indexable CMS pages, never private routes", async () => {
  product("anchor");
  db.insert("pageSeo", { id: "s1", key: "contact", noIndex: true, canonicalUrl: null });
  db.insert("pageSeo", { id: "s2", key: "terms", noIndex: false, canonicalUrl: "/privacy" });
  db.insert("staticPage", { id: "c1", title: "T", content: "<p>x</p>", seoKeywords: [], slug: "gift-guide", systemKey: null, isPublished: true, noIndex: false, canonicalUrl: null, sortOrder: 0 });
  db.insert("staticPage", { id: "c2", title: "T", content: "<p>x</p>", seoKeywords: [], slug: "draft-page", systemKey: null, isPublished: false, noIndex: false, canonicalUrl: null, sortOrder: 0 });
  db.insert("staticPage", { id: "c3", title: "T", content: "<p>x</p>", seoKeywords: [], slug: "hidden-page", systemKey: null, isPublished: true, noIndex: true, canonicalUrl: null, sortOrder: 0 });
  db.insert("staticPage", { id: "c4", title: "T", content: "<p>x</p>", seoKeywords: [], slug: "about-us", systemKey: "about-us", isPublished: true, noIndex: false, canonicalUrl: null, sortOrder: 0 });
  const urls = (await getPageSitemapEntries()).map((e) => e.url);
  assert.ok(urls.every((u) => ORIGIN_RE.test(u) && u.startsWith("https://shop.example.com")));
  assert.ok(urls.includes("https://shop.example.com"), "homepage is listed");
  assert.ok(urls.includes("https://shop.example.com/pages/gift-guide"));
  assert.ok(urls.includes("https://shop.example.com/about-us"), "system page listed once, at its own URL");
  assert.equal(urls.filter((u) => u.endsWith("/about-us")).length, 1);
  for (const gone of ["/contact", "/terms", "/pages/draft-page", "/pages/hidden-page", "/pages/about-us"]) assert.ok(!urls.includes(`https://shop.example.com${gone}`), gone);
  for (const priv of ["/admin", "/cart", "/checkout", "/account", "/login", "/search"]) assert.ok(!urls.some((u) => new URL(u).pathname.startsWith(priv)), priv);
  assert.equal(new Set(urls).size, urls.length, "no duplicate URLs");
});

test("redirect lookup: active rules resolve, inactive are ignored, loops fail open, chains collapse", async () => {
  db.insert("redirect", { id: "r1", fromPath: "/old", toPath: "/mid", statusCode: 301, isActive: true });
  db.insert("redirect", { id: "r2", fromPath: "/mid", toPath: "/new", statusCode: 301, isActive: true });
  db.insert("redirect", { id: "r3", fromPath: "/off", toPath: "/new", statusCode: 301, isActive: false });
  db.insert("redirect", { id: "r4", fromPath: "/loop-a", toPath: "/loop-b", statusCode: 302, isActive: true });
  db.insert("redirect", { id: "r5", fromPath: "/loop-b", toPath: "/loop-a", statusCode: 302, isActive: true });
  assert.deepEqual(await findActiveRedirect("/old"), { to: "/new", status: 301 });
  assert.equal(await findActiveRedirect("/off"), null);
  assert.equal(await findActiveRedirect("/loop-a"), null);
  assert.equal(await findActiveRedirect("/nothing"), null);
});

test("robots.txt: built from admin settings, private paths always blocked, essential routes never blocked, sitemap on the configured origin", async () => {
  await db.storeSettings.update({ where: { id: "singleton" }, data: { seoRobotsExtra: "Disallow: /staging-only\nDisallow: /shop\nDisallow: /" } });
  const r = await robots();
  const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
  const dis = ([] as string[]).concat(rule.disallow ?? []);
  assert.ok(dis.includes("/admin") && dis.includes("/checkout") && dis.includes("/api/"));
  assert.ok(dis.includes("/staging-only"));
  assert.ok(!dis.includes("/shop") && !dis.includes("/"));
  assert.equal(rule.allow, "/");
  assert.equal(r.sitemap, "https://shop.example.com/sitemap.xml");
});

test("sitemap index lists chunk URLs on the configured origin", async () => {
  product("one");
  const xml = await (await sitemapIndex()).text();
  assert.match(xml, /<loc>https:\/\/shop\.example\.com\/sitemap\/0\.xml<\/loc>/);
});
