import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGlobalSeo, validatePageSeo, validateEntitySeo, validateStaticPage, validateRedirect } from "@/lib/seo-validate";

const O = "https://www.example.com";
const strip = (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, "");

test("global settings: template needs %s, base URL is https origin, unknown twitter card falls back", () => {
  assert.equal(validateGlobalSeo({ seoTitleTemplate: "no placeholder" }).ok, false);
  assert.equal(validateGlobalSeo({ seoCanonicalBaseUrl: "http://example.com" }).ok, false);
  const ok = validateGlobalSeo({ seoTitleTemplate: "%s | GP", seoCanonicalBaseUrl: "https://www.example.com/", seoTwitterCard: "player", seoKeywords: ["a", "A", " b "], seoDefaultNoIndex: true });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.seoCanonicalBaseUrl, O);
    assert.equal(ok.value.seoTwitterCard, "summary_large_image");
    assert.deepEqual(ok.value.seoKeywords, ["a", "b"]);
    assert.equal(ok.value.seoDefaultNoIndex, true);
    assert.equal(ok.value.seoOrgSchemaEnabled, true);
  }
  assert.equal(validateGlobalSeo({ seoRobotsExtra: "x".repeat(2001) }).ok, false);
});

test("page/entity SEO: lengths, image scheme, canonical host and directives are enforced server-side", () => {
  assert.equal(validatePageSeo({ title: "x".repeat(121) }, O).ok, false);
  assert.equal(validatePageSeo({ ogImage: "javascript:alert(1)" }, O).ok, false);
  assert.equal(validatePageSeo({ ogImage: "data:image/png;base64,AAAA" }, O).ok, false);
  assert.equal(validatePageSeo({ canonicalUrl: "https://evil.com/x" }, O).ok, false);
  assert.equal(validatePageSeo({ robotsDirectives: "noindex" }, O).ok, false);
  assert.equal(validatePageSeo({ title: 5 }, O).ok, false);
  const ok = validatePageSeo({ title: " Home ", canonicalUrl: "/", ogImage: "/img/og.jpg", robotsDirectives: "NoArchive", noIndex: true }, O);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual([ok.value.title, ok.value.canonicalUrl, ok.value.robotsDirectives, ok.value.noIndex, ok.value.noFollow], ["Home", O, "noarchive", true, false]);
  const e = validateEntitySeo({ title: "", canonical: "/products/a/", noindex: true }, O);
  assert.deepEqual(e.ok && [e.value.title, e.value.canonical, e.value.noindex], [null, `${O}/products/a`, true]);
});

test("static page: slug rules, sanitizer is applied, empty pages cannot be published", () => {
  const base = { title: "Gift guide", slug: "gift-guide", content: "<p>Hi</p><script>alert(1)</script>" };
  const ok = validateStaticPage({ ...base, isPublished: true }, O, strip);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.content, "<p>Hi</p>");
  assert.equal(validateStaticPage({ ...base, slug: "admin" }, O, strip).ok, false);
  assert.equal(validateStaticPage({ ...base, slug: "Bad Slug" }, O, strip).ok, false);
  assert.equal(validateStaticPage({ ...base, title: "  " }, O, strip).ok, false);
  assert.equal(validateStaticPage({ ...base, content: "<script>x</script>", isPublished: true }, O, strip).ok, false);
  assert.equal(validateStaticPage({ ...base, content: "", isPublished: false }, O, strip).ok, true);
  // System pages ignore the submitted slug.
  const sys = validateStaticPage({ ...base, slug: "hacked" }, O, strip, { slug: "about-us" });
  assert.equal(sys.ok && sys.value.slug, "about-us");
});

test("redirect form: valid pair, same-path, external destination and bad status are rejected", () => {
  const ok = validateRedirect({ fromPath: "old/", toPath: "/new", statusCode: "301" }, O);
  assert.deepEqual(ok, { ok: true, value: { fromPath: "/old", toPath: "/new", statusCode: 301, isActive: true } });
  assert.equal(validateRedirect({ fromPath: "/a", toPath: "/a/", statusCode: 301 }, O).ok, false);
  assert.equal(validateRedirect({ fromPath: "/a", toPath: "https://evil.com", statusCode: 301 }, O).ok, false);
  assert.equal(validateRedirect({ fromPath: "/a", toPath: "/b", statusCode: 307 }, O).ok, false);
  assert.equal(validateRedirect({ fromPath: "/admin", toPath: "/b", statusCode: 301 }, O).ok, false);
  assert.equal(validateRedirect({ fromPath: "/a", toPath: "/b", statusCode: 302, isActive: false }, O).ok && true, true);
});
