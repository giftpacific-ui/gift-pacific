import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  abandonedCartEventKey, evaluateMarketingEligibility, generateUnsubscribeToken, hashUnsubscribeToken, incompleteCheckoutEventKey,
  isUnsubscribeTokenHash, normalizeContactEmail, MARKETING_SKIP_REASONS,
} from "@/lib/email/marketing";

const ok = (v: unknown) => { const r = normalizeContactEmail(v); assert.ok(r.ok, String(v)); return r.email; };

test("addresses normalise to one form: trimmed, lower-case, NFKC; +tags and dots are left alone", () => {
  assert.equal(ok("  Jane.Doe@Example.COM "), "jane.doe@example.com");
  assert.equal(ok("A@X.com"), ok("a@x.com"));
  assert.equal(ok("ａ@example.com"), "a@example.com", "full-width letters fold to ASCII (NFKC)");
  assert.equal(ok("jane+shop@gmail.com"), "jane+shop@gmail.com");
  assert.notEqual(ok("j.ane@gmail.com"), ok("jane@gmail.com"), "different mailboxes at other providers must not be merged");
  assert.equal(ok(ok("  MiXed@Example.com ")), "mixed@example.com", "idempotent");
});

test("unusable addresses are rejected with a fixed message (no lists, display names, control characters, non-strings)", () => {
  for (const bad of ["", "   ", "nope", "a@b", "a b@example.com", "a@example.com, b@example.com", "Jane <a@example.com>", "a@example.com\r\nBcc: x@y.com", "a@exa\u0000mple.com", null, undefined, 42, {}, "x".repeat(300) + "@example.com"]) {
    const r = normalizeContactEmail(bad);
    assert.equal(r.ok, false, String(bad));
    if (!r.ok) assert.ok(r.message.length > 0 && !r.message.includes("Bcc"));
  }
});

test("unsubscribe tokens: 256-bit, URL-safe, unique; only the SHA-256 hash is meant for storage", () => {
  const a = generateUnsubscribeToken();
  const b = generateUnsubscribeToken();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.token, b.token);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.hash, a.token);
  assert.ok(!a.hash.includes(a.token));
  assert.equal(hashUnsubscribeToken(a.token), a.hash, "the same token always hashes the same, so a link can be looked up");
  assert.ok(isUnsubscribeTokenHash(a.hash));
  assert.ok(!isUnsubscribeTokenHash(a.token));
});

test("a malformed token never produces a hash (so it can never reach a database lookup)", () => {
  for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "=", "a".repeat(42) + "!", null, undefined, 1, {}]) assert.equal(hashUnsubscribeToken(bad), null, String(bad));
});

test("recovery event keys: deterministic per event, distinct per kind, new activity = new event", () => {
  assert.equal(incompleteCheckoutEventKey("ckabc123"), "ic:ckabc123");
  assert.equal(incompleteCheckoutEventKey("ckabc123"), incompleteCheckoutEventKey("ckabc123"));
  const t1 = new Date("2026-11-20T10:00:00.000Z");
  const t2 = new Date("2026-11-22T10:00:00.000Z");
  assert.equal(abandonedCartEventKey("cart1", t1), `ac:cart1:${t1.getTime()}`);
  assert.equal(abandonedCartEventKey("cart1", t1), abandonedCartEventKey("cart1", new Date(t1)), "the same abandonment gives the same key");
  assert.notEqual(abandonedCartEventKey("cart1", t1), abandonedCartEventKey("cart1", t2), "the cart was used again: a new abandonment");
  assert.notEqual(abandonedCartEventKey("cart1", t1), abandonedCartEventKey("cart2", t1));
  // an id that happens to equal a cart id can never collide across kinds (different prefix)
  assert.notEqual(incompleteCheckoutEventKey("x1"), abandonedCartEventKey("x1", t1));
});

test("event keys refuse unusable input", () => {
  for (const bad of ["", "a:b", "a b", "x".repeat(65), null as never, undefined as never, 5 as never]) {
    assert.equal(incompleteCheckoutEventKey(bad), null, String(bad));
    assert.equal(abandonedCartEventKey(bad, new Date()), null, String(bad));
  }
  assert.equal(abandonedCartEventKey("c1", new Date("nope")), null);
  assert.equal(abandonedCartEventKey("c1", "2026-01-01" as never), null);
});

const contact = { isActive: true };
test("eligibility: needs an ACTIVE contact, an OPEN consent and NO suppression", () => {
  assert.deepEqual(evaluateMarketingEligibility({ contact, hasOpenConsent: true, suppressed: false }), { eligible: true });
  assert.deepEqual(evaluateMarketingEligibility({ contact: null, hasOpenConsent: false, suppressed: false }), { eligible: false, reason: "no_contact" });
  assert.deepEqual(evaluateMarketingEligibility({ contact, hasOpenConsent: false, suppressed: false }), { eligible: false, reason: "no_consent" });
  assert.deepEqual(evaluateMarketingEligibility({ contact: { isActive: false }, hasOpenConsent: true, suppressed: false }), { eligible: false, reason: "inactive" });
});

test("a suppression wins over everything, including a valid consent and a missing contact", () => {
  assert.deepEqual(evaluateMarketingEligibility({ contact, hasOpenConsent: true, suppressed: true }), { eligible: false, reason: "suppressed" });
  assert.deepEqual(evaluateMarketingEligibility({ contact: { isActive: false }, hasOpenConsent: false, suppressed: true }), { eligible: false, reason: "suppressed" });
  assert.deepEqual(evaluateMarketingEligibility({ contact: null, hasOpenConsent: false, suppressed: true }), { eligible: false, reason: "suppressed" });
});

test("every skip reason the rule can return is in the fixed vocabulary", () => {
  const seen = new Set<string>();
  for (const contactV of [null, contact, { isActive: false }]) for (const c of [true, false]) for (const s of [true, false]) {
    const r = evaluateMarketingEligibility({ contact: contactV, hasOpenConsent: c, suppressed: s });
    if (!r.eligible) seen.add(r.reason);
  }
  for (const reason of seen) assert.ok((MARKETING_SKIP_REASONS as readonly string[]).includes(reason), reason);
});

test("architecture: the marketing rules are pure, server-side only, and never read checkout-progress consent", () => {
  const src = readFileSync(new URL("../../src/lib/email/marketing.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(src, /^\/\*\*[\s\S]*PURE/m);
  assert.ok(!/prisma|fetch\(|process\.env/.test(code), "no database, network or environment access");
  assert.ok(!/consentAt/.test(code), "IncompleteCheckout.consentAt (consent to SAVE progress) is not a marketing consent and is never read here");
  // nothing a browser bundle can load may import src/lib/email
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const base = new URL("../../src/", import.meta.url).pathname;
  for (const dirName of ["features", "components"]) {
    for (const f of walk(join(base, dirName)).filter((p) => /\.(ts|tsx)$/.test(p))) {
      assert.ok(!/from ["']@\/lib\/email\//.test(readFileSync(f, "utf8")), `${f} must not import lib/email`);
    }
  }
});
