import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The home page is an async server component and cannot be rendered by the unit harness, so this is a STATIC guard for a defect
// found in the emergency-release HTTP smoke test: with no active Campaign banner the page read `campaignBanner.imageUrl` and
// returned HTTP 500. (The real verification is an HTTP request against a database with no banners — see RELEASE_AUDIT.md.)
test("home page never dereferences the optional campaign banner without a guard", () => {
  const src = readFileSync("src/app/(shop)/page.tsx", "utf8");
  const uses = [...src.matchAll(/campaignBanner(\??)\.(\w+)/g)];
  assert.ok(uses.length > 0);
  const lines = src.split("\n");
  for (const m of uses) {
    const idx = src.slice(0, m.index).split("\n").length - 1;
    const guarded = m[1] === "?" || /^\s*(title|subtitle|imageUrl|ctaLabel):/.test(lines[idx]); // the latter sit inside `{campaignBanner && (…)}`
    assert.ok(guarded, `unguarded ${m[0]} at line ${idx + 1}`);
  }
});
