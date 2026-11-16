import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBaseUrl, normalizeCanonicalOverride, parseRobotsDirectives, buildRobotsMeta, robotsMetaToString,
  buildRobotsTxtRules, resolveSeoFields, mergeSeoOverrides, auditSeoRecord, findDuplicates, isSitemapEligible, joinOrigin,
} from "@/lib/seo-rules";

const O = "https://www.example.com";

test("base URL: https origin only; empty means 'use the default'", () => {
  assert.deepEqual(normalizeBaseUrl(""), { ok: true, value: null });
  assert.deepEqual(normalizeBaseUrl("https://www.example.com/"), { ok: true, value: O });
  assert.equal(normalizeBaseUrl("http://example.com").ok, false);
  assert.deepEqual(normalizeBaseUrl("http://localhost:3000"), { ok: true, value: "http://localhost:3000" });
  assert.equal(normalizeBaseUrl("https://example.com/shop").ok, false);
  assert.equal(normalizeBaseUrl("https://user:pw@example.com").ok, false);
  assert.equal(normalizeBaseUrl("javascript:alert(1)").ok, false);
});

test("canonical override: same host or path only, query/hash dropped, no trailing slash", () => {
  assert.deepEqual(normalizeCanonicalOverride("", O), { ok: true, value: null });
  assert.deepEqual(normalizeCanonicalOverride("/about-us/", O), { ok: true, value: `${O}/about-us` });
  assert.deepEqual(normalizeCanonicalOverride(`${O}/shop?page=2#x`, O), { ok: true, value: `${O}/shop` });
  assert.deepEqual(normalizeCanonicalOverride("/", O), { ok: true, value: O });
  for (const bad of ["https://evil.com/x", "//evil.com", "/\\evil.com", "javascript:alert(1)", "/a b", "ftp://www.example.com/x", "https://u:p@www.example.com/x"]) {
    assert.equal(normalizeCanonicalOverride(bad, O).ok, false, bad);
  }
});

test("robots directives: allowlist only; index/follow words are rejected to avoid conflicts", () => {
  const ok = parseRobotsDirectives("NoArchive, max-snippet:50, max-image-preview:large");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.normalized, "noarchive, max-snippet:50, max-image-preview:large");
  for (const bad of ["noindex", "follow", "none", "unavailable_after: 1 Jan", "max-image-preview:huge", "max-snippet:abc", "<script>"]) {
    assert.equal(parseRobotsDirectives(bad).ok, false, bad);
  }
  const meta = buildRobotsMeta({ noindex: true, nofollow: false, directives: "nosnippet" });
  assert.equal(meta.index, false);
  assert.equal(meta.follow, true);
  assert.equal(meta.nosnippet, true);
  assert.equal(robotsMetaToString(meta), "noindex, follow, nosnippet");
  // Invalid stored text is ignored, never emitted.
  assert.deepEqual(buildRobotsMeta({ directives: "noindex, evil" }), { index: true, follow: true });
});

test("robots.txt: private paths always blocked; essential routes can never be blocked by extra rules", () => {
  const r = buildRobotsTxtRules(["Disallow: /staging-preview", "/tmp-campaign", "Disallow: /", "Disallow: /shop", "Disallow: /s", "/products/secret", "Disallow: /a*b", "nonsense here", "# comment"].join("\n"));
  assert.ok(r.disallow.includes("/admin") && r.disallow.includes("/checkout") && r.disallow.includes("/api/"));
  assert.ok(r.disallow.includes("/staging-preview") && r.disallow.includes("/tmp-campaign"));
  for (const blocked of ["/", "/shop", "/s", "/products/secret", "/a*b"]) assert.equal(r.disallow.includes(blocked), false, blocked);
  assert.equal(r.rejected.length, 6);
  assert.ok(!r.disallow.includes("/pages"));
});

test("fallback: page override > route default > global; global default title is the last resort", () => {
  const global = { defaultTitle: "Gift Pacific", description: "Global desc", keywords: ["gift"], ogTitle: "Global OG", ogImage: "https://x/g.jpg", twitterCard: "summary" };
  const none = resolveSeoFields(null, {}, global);
  assert.equal(none.title, "Gift Pacific");
  assert.equal(none.description, "Global desc");
  assert.equal(none.image, "https://x/g.jpg");
  assert.equal(none.ogTitle, "Global OG");
  assert.equal(none.twitterCard, "summary");

  const route = resolveSeoFields(null, { title: "Contact", description: "Route desc", image: "https://x/r.jpg" }, global);
  assert.equal(route.title, "Contact");
  assert.equal(route.description, "Route desc");
  assert.equal(route.image, "https://x/r.jpg");

  const over = resolveSeoFields({ title: " Custom ", description: "", ogImage: "https://x/o.jpg", ogTitle: "OG!" }, { title: "Contact", description: "Route desc" }, global);
  assert.equal(over.title, "Custom");
  assert.equal(over.titleFromOverride, true);
  assert.equal(over.description, "Route desc"); // blank override falls through, never emits empty metadata
  assert.equal(over.image, "https://x/o.jpg");
  assert.equal(over.ogTitle, "OG!");
});

test("noindex: global default noindex cannot be undone by a page; page/route noindex wins over index", () => {
  assert.equal(resolveSeoFields({ noIndex: false }, {}, { defaultNoIndex: true }).noindex, true);
  assert.equal(resolveSeoFields({ noIndex: true }, {}, {}).noindex, true);
  assert.equal(resolveSeoFields(null, { noindex: true }, {}).noindex, true);
  assert.equal(resolveSeoFields(null, {}, {}).noindex, false);
});

test("audit flags missing and invalid SEO data without inventing scores", () => {
  assert.deepEqual(auditSeoRecord({}, O), ["missing-title", "missing-description", "missing-image"]);
  const issues = auditSeoRecord({ title: "T", description: "D", image: "i", noindex: true, canonical: "https://evil.com", path: "/p" }, O);
  assert.deepEqual(issues, ["noindex", "invalid-canonical"]);
  assert.deepEqual(auditSeoRecord({ title: "T", description: "D", image: "i", canonical: "/other", path: "/p" }, O), ["canonical-elsewhere"]);
  assert.deepEqual(auditSeoRecord({ title: "T", description: "D", image: "i", canonical: "/p/", path: "/p" }, O), []);
});

test("duplicates are grouped case/space-insensitively and singletons are ignored", () => {
  const d = findDuplicates([{ id: "1", t: "Blue  Mug" }, { id: "2", t: "blue mug" }, { id: "3", t: "Red" }, { id: "4", t: "" }, { id: "5", t: "" }], (x) => x.t);
  assert.deepEqual(d, [{ value: "blue mug", ids: ["1", "2"] }]);
});

test("sitemap eligibility: noindex, private routes and canonical-elsewhere are excluded", () => {
  assert.equal(isSitemapEligible({ path: "/products/a" }, O), true);
  assert.equal(isSitemapEligible({ path: "/products/a", noindex: true }, O), false);
  for (const p of ["/admin", "/admin/orders", "/cart", "/checkout", "/checkout/success", "/account/orders", "/login", "/search", "/api/x"]) assert.equal(isSitemapEligible({ path: p }, O), false, p);
  assert.equal(isSitemapEligible({ path: "/products/a", canonical: "/products/b" }, O), false);
  assert.equal(isSitemapEligible({ path: "/products/a", canonical: `${O}/products/a/` }, O), true);
  assert.equal(joinOrigin(O, "/"), O);
});

test("override merge: higher layer wins per field, blanks fall through, noindex/nofollow can only be added", () => {
  const cms = { title: "CMS", description: "  ", keywords: [], canonicalUrl: "/a", noIndex: false };
  const page = { title: "Page", description: "Page desc", keywords: ["k"], ogImage: "https://x/p.jpg", noIndex: true, noFollow: true };
  const m = mergeSeoOverrides(cms, page);
  assert.deepEqual([m.title, m.description, m.canonicalUrl, m.ogImage, m.keywords], ["CMS", "Page desc", "/a", "https://x/p.jpg", ["k"]]);
  assert.equal(m.noIndex, true, "Page SEO noindex survives a CMS layer that does not set it");
  assert.equal(m.noFollow, true);
  const none = mergeSeoOverrides(null, undefined);
  assert.deepEqual([none.title, none.noIndex, none.noFollow], [undefined, false, false]);
});
