import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeHttpUrl, isSafeImageUrl, isSafeLinkTarget, isSafeRelativePath } from "@/lib/url-safety";
import { serializeJsonLd } from "@/lib/json-ld";
import { isValidPixelId, isValidTrackingId } from "@/lib/analytics/ids";
import { sanitizeProductHtml } from "@/lib/sanitize-html";

test("URL allow-list rejects script-capable schemes and tricks", () => {
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,AAAA", "vbscript:x", "file:///etc/passwd", "//evil.com", "ftp://x.com", "https://", " javascript:alert(1)", "blob:https://x"]) {
    assert.equal(isSafeHttpUrl(bad), false, bad);
    assert.equal(isSafeImageUrl(bad), false, bad);
    assert.equal(isSafeLinkTarget(bad), false, bad);
  }
  assert.equal(isSafeHttpUrl("https://res.cloudinary.com/x/y.png"), true);
  assert.equal(isSafeLinkTarget("/shop"), true);
  assert.equal(isSafeRelativePath("/\\evil.com"), false);
  assert.equal(isSafeRelativePath("//evil.com"), false);
});

test("JSON-LD can't break out of its <script> tag", () => {
  const out = serializeJsonLd({ name: "</script><script>alert(1)</script>", n: "a&b\u2028" });
  assert.ok(!out.includes("<"));
  assert.ok(!out.includes(">"));
  assert.deepEqual(JSON.parse(out), { name: "</script><script>alert(1)</script>", n: "a&b\u2028" }); // same data after parse
});

test("analytics IDs must match real formats (they go into inline scripts)", () => {
  assert.equal(isValidTrackingId("G-ABC123XYZ9"), true);
  assert.equal(isValidTrackingId("GTM-ABCD123"), true);
  assert.equal(isValidTrackingId("');alert(1);//"), false);
  assert.equal(isValidTrackingId("G-<script>"), false);
  assert.equal(isValidPixelId("1234567890"), true);
  assert.equal(isValidPixelId("1');alert(1);//"), false);
  assert.equal(isValidPixelId(null), false);
});

test("product HTML sanitizer strips scripts, handlers and javascript: links", () => {
  const out = sanitizeProductHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>');
  assert.ok(!/script|onclick|onerror|javascript:/i.test(out), out);
  assert.ok(out.includes("Hi"));
});

import { safeRedirectPath } from "@/lib/url-safety";
test("post-login redirect only allows same-site paths (no open redirect)", () => {
  for (const bad of ["//evil.com", "https://evil.com", "javascript:alert(1)", "/\\evil.com", "evil.com", "", null, undefined]) {
    assert.equal(safeRedirectPath(bad as never, "/account"), "/account", String(bad));
  }
  assert.equal(safeRedirectPath("/checkout?x=1", "/account"), "/checkout?x=1");
});
