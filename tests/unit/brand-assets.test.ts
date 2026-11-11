import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import manifest from "../../src/app/manifest";
import { siteConfig } from "../../src/config/site";

// Phase 1 (branding): no official Gift Pacific logo/favicon/share-image asset exists yet. These guards make sure nothing
// points at a file that is not there, and that the minimal web manifest stays honest (name only, no invented icons).

test("web manifest uses the official name and declares no icons, service worker or invented assets", () => {
  const m = manifest() as Record<string, unknown>;
  assert.equal(m.name, "Gift Pacific");
  assert.equal(m.short_name, "Gift Pacific");
  assert.equal(m.name, siteConfig.name);
  assert.equal(m.start_url, "/");
  assert.equal(m.lang, "en");
  assert.ok(!("icons" in m), "no icons until the owner supplies official assets");
  assert.ok(!("serviceworker" in m) && !("service_worker" in m));
});

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

test("source never references a static brand asset path that does not exist in public/", () => {
  // Static asset URLs like "/images/logo.png" or "/favicon.ico" that the app would request from public/.
  const re = /["'`](\/(?:images|img|icons?|assets|logo|favicon|apple-touch-icon|android-chrome|og)[A-Za-z0-9_./-]*)["'`]/g;
  const missing: string[] = [];
  for (const file of walk("src")) {
    if (!/\.(tsx?|css)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) {
      if (!existsSync(path.join("public", m[1]))) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the loading screen shows the store name as text, not an image file, when no logo is set", () => {
  const src = readFileSync("src/app/loading.tsx", "utf8");
  assert.ok(!/\.(png|jpe?g|svg|ico|webp)/i.test(src), "no static image file in the loading screen");
  assert.ok(/logoUrl\s*\?/.test(src), "the image renders only when a logo URL exists");
  assert.ok(/storeName/.test(src));
});

test("root metadata emits favicon and share image only when the owner configured them", () => {
  const src = readFileSync("src/app/layout.tsx", "utf8");
  assert.ok(/icons:\s*settings\.faviconUrl\s*\?/.test(src));
  assert.ok(/settings\.ogImageUrl\s*\?/.test(src));
  assert.ok(!/\/favicon\.ico|\/images\//.test(src));
});
