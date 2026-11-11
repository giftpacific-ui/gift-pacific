import { test } from "node:test";
import assert from "node:assert/strict";
import nextConfig from "../../next.config";

test("every route gets nosniff, X-Frame-Options DENY and a strict referrer policy", async () => {
  const rules = await nextConfig.headers!();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source, "/:path*");
  const h = Object.fromEntries(rules[0].headers.map((x) => [x.key, x.value]));
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.equal(h["Referrer-Policy"], "strict-origin-when-cross-origin");
});

test("no Content-Security-Policy is set until it is designed against GTM/Pixel/Cloudinary (documented decision)", async () => {
  const rules = await nextConfig.headers!();
  assert.ok(!rules[0].headers.some((x) => /content-security-policy/i.test(x.key)));
});
