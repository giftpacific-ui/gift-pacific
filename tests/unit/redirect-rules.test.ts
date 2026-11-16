import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRedirectSource, validateRedirectDestination, detectRedirectLoop, resolveRedirect, normalizeRedirectPath } from "@/lib/redirect-rules";

const O = "https://www.example.com";

test("source: site path only, normalised; protected areas refused", () => {
  assert.deepEqual(validateRedirectSource("old-page/"), { ok: true, value: "/old-page" });
  for (const bad of ["", "/", "https://x.com/a", "//x.com", "/a?b=1", "/a#b", "/a b", "/admin", "/admin/orders", "/api/x", "/_next/x", "/checkout", "/account/orders"]) {
    assert.equal(validateRedirectSource(bad).ok, false, bad);
  }
});

test("destination: same-site only — no open redirects", () => {
  assert.deepEqual(validateRedirectDestination("/new/", O), { ok: true, value: "/new" });
  assert.deepEqual(validateRedirectDestination(`${O}/new?x=1`, O), { ok: true, value: "/new?x=1" });
  for (const bad of ["https://evil.com/x", "//evil.com", "/\\evil.com", "javascript:alert(1)", "data:text/html,x", "https://u:p@www.example.com/x", "/a b", "", "/api/x"]) {
    assert.equal(validateRedirectDestination(bad, O).ok, false, bad);
  }
});

test("loop detection: self, direct, chained and long chains", () => {
  const existing = new Map([["/b", "/c"], ["/c", "/d"]]);
  assert.equal(detectRedirectLoop("/a", "/a", existing).ok, false);
  assert.equal(detectRedirectLoop("/d", "/b", existing).ok, false); // d → b → c → d
  assert.equal(detectRedirectLoop("/a", "/b", existing).ok, true);
  assert.equal(detectRedirectLoop("/a", "/b?x=1", existing).ok, true);
  const long = new Map(Array.from({ length: 12 }, (_, i) => [`/p${i}`, `/p${i + 1}`] as const));
  assert.equal(detectRedirectLoop("/start", "/p0", long).ok, false);
});

test("resolve: chains collapse to the final target; loops and misses return null", () => {
  const m = new Map([["/a", { to: "/b", status: 301 }], ["/b", { to: "/c", status: 301 }], ["/x", { to: "/y", status: 302 }], ["/y", { to: "/x", status: 302 }]]);
  assert.deepEqual(resolveRedirect("/a/", m), { to: "/c", status: 301 });
  assert.equal(resolveRedirect("/x", m), null);
  assert.equal(resolveRedirect("/nope", m), null);
  assert.equal(normalizeRedirectPath("/A//b/"), "/A/b");
});
