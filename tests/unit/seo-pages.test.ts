import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePageSlug, slugFromTitle, RESERVED_SLUGS, SYSTEM_PAGES, systemKeyForPath, staticPagePath } from "@/lib/seo-pages";

test("slug validation: format, length and reserved names", () => {
  assert.deepEqual(validatePageSlug("  Gift-Guide "), { ok: true, slug: "gift-guide" });
  for (const bad of ["a", "has space", "under_score", "a/b", "-lead", "trail-", "dou--ble", "dot.html", "ইউনিকোড", "x".repeat(81)]) {
    assert.equal(validatePageSlug(bad).ok, false, bad);
  }
  for (const reserved of ["admin", "api", "shop", "products", "cart", "checkout", "about-us", "privacy", "pages", "sitemap", "login"]) {
    assert.equal(validatePageSlug(reserved).ok, false, reserved);
  }
});

test("every built-in route is reserved so a CMS slug can never shadow it", () => {
  for (const p of SYSTEM_PAGES) {
    const first = p.path.split("/")[1];
    if (first) assert.ok(RESERVED_SLUGS.has(first), first);
  }
});

test("slug suggestion is ASCII-only and path mapping keeps system routes stable", () => {
  assert.equal(slugFromTitle("Our Gift Guide!"), "our-gift-guide");
  assert.equal(systemKeyForPath("/about-us/"), "about-us");
  assert.equal(staticPagePath({ slug: "about-us", systemKey: "about-us" }), "/about-us");
  assert.equal(staticPagePath({ slug: "gift-guide" }), "/pages/gift-guide");
});
