import { test } from "node:test";
import assert from "node:assert/strict";
import nextConfig from "../../next.config";

test("the framework banner header is disabled", () => {
  assert.equal(nextConfig.poweredByHeader, false);
});

test("security headers remain on every route and the optimizer is not switched off by a custom loader", async () => {
  const rules = await nextConfig.headers!();
  const all = rules.find((r) => r.source === "/:path*")!;
  const keys = all.headers.map((h) => h.key);
  for (const k of ["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"]) assert.ok(keys.includes(k), k);
  assert.equal((nextConfig.images as { loader?: string }).loader, undefined); // `loader: "custom"` disables /_next/image
});
