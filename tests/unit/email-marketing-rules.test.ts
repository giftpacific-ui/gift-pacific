import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cleanOptionalText, consentMayLiftUnsubscribe, isConsentCurrentlyValid, isConsentSource, isContactSource, isSuppressionReason, isUnsubscribeSource,
  outranksSuppression, unsubscribeSourceForSuppression, CONSENT_SOURCES, SUPPRESSION_REASONS,
} from "@/lib/email/marketing-rules";
import { MARKETING_SKIP_REASONS } from "@/lib/email/marketing";

test("source guards accept only the schema's values; checkout-progress consent is not a marketing consent source", () => {
  assert.deepEqual([...CONSENT_SOURCES], ["ADMIN_RECORDED", "CSV_IMPORT", "CUSTOMER_ACCOUNT", "CHECKOUT_MARKETING", "SIGNUP_FORM"]);
  for (const bad of ["CHECKOUT_PROGRESS", "INCOMPLETE_CHECKOUT", "PROGRESS_SAVING", "checkout_marketing", "", null, undefined, 1]) assert.equal(isConsentSource(bad), false, String(bad));
  assert.equal(isConsentSource("CHECKOUT_MARKETING"), true);
  assert.equal(isContactSource("CUSTOMER"), true);
  assert.equal(isContactSource("IMPORT"), false);
  assert.equal(isUnsubscribeSource("BOUNCE"), true);
  assert.equal(isUnsubscribeSource("EMAIL"), false);
  assert.deepEqual([...SUPPRESSION_REASONS], ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "ADMIN"]);
  assert.equal(isSuppressionReason("COMPLAINED"), true);
  assert.equal(isSuppressionReason("OTHER"), false);
});

test("cleanOptionalText: blank is nothing, whitespace collapses, control characters go, too long or non-string is invalid", () => {
  assert.deepEqual(cleanOptionalText(undefined, 10), { ok: true, value: null });
  assert.deepEqual(cleanOptionalText(null, 10), { ok: true, value: null });
  assert.deepEqual(cleanOptionalText("   ", 10), { ok: true, value: null });
  assert.deepEqual(cleanOptionalText("  a \n\t b  ", 10), { ok: true, value: "a b" });
  assert.deepEqual(cleanOptionalText("a\u0000b", 10), { ok: true, value: "a b" });
  assert.deepEqual(cleanOptionalText("x".repeat(10), 10), { ok: true, value: "x".repeat(10) });
  assert.deepEqual(cleanOptionalText("x".repeat(11), 10), { ok: false });
  assert.deepEqual(cleanOptionalText(5, 10), { ok: false });
  assert.deepEqual(cleanOptionalText({}, 10), { ok: false });
});

test("a stronger suppression is never downgraded: COMPLAINED > BOUNCED > ADMIN > UNSUBSCRIBED", () => {
  assert.equal(outranksSuppression("COMPLAINED", "BOUNCED"), true);
  assert.equal(outranksSuppression("BOUNCED", "ADMIN"), true);
  assert.equal(outranksSuppression("ADMIN", "UNSUBSCRIBED"), true);
  assert.equal(outranksSuppression("UNSUBSCRIBED", "ADMIN"), false);
  assert.equal(outranksSuppression("BOUNCED", "COMPLAINED"), false);
  for (const r of SUPPRESSION_REASONS) assert.equal(outranksSuppression(r, r), false, "equal does not outrank");
});

test("the unsubscribe source stamped on a closed consent follows the suppression reason", () => {
  assert.equal(unsubscribeSourceForSuppression("BOUNCED"), "BOUNCE");
  assert.equal(unsubscribeSourceForSuppression("COMPLAINED"), "COMPLAINT");
  assert.equal(unsubscribeSourceForSuppression("ADMIN", "LINK"), "ADMIN");
  assert.equal(unsubscribeSourceForSuppression("UNSUBSCRIBED", "CUSTOMER_ACCOUNT"), "CUSTOMER_ACCOUNT");
  assert.equal(unsubscribeSourceForSuppression("UNSUBSCRIBED"), "LINK");
  assert.equal(unsubscribeSourceForSuppression("UNSUBSCRIBED", "BOUNCE"), "LINK", "a bounce is not an unsubscribe request");
});

test("which consents may end an unsubscribe: never a bulk import, admin only with evidence, the person's own acts yes", () => {
  assert.equal(consentMayLiftUnsubscribe({ source: "CSV_IMPORT", evidence: "list.csv" }), false);
  assert.equal(consentMayLiftUnsubscribe({ source: "ADMIN_RECORDED", evidence: null }), false);
  assert.equal(consentMayLiftUnsubscribe({ source: "ADMIN_RECORDED", evidence: "phone call 2026-11-20" }), true);
  for (const source of ["CUSTOMER_ACCOUNT", "CHECKOUT_MARKETING", "SIGNUP_FORM"] as const) assert.equal(consentMayLiftUnsubscribe({ source, evidence: null }), true, source);
});

test("a consent is valid only while open, from a known source, granted at a real moment not in the future", () => {
  const now = new Date("2026-11-24T10:00:00.000Z");
  const ok = { source: "SIGNUP_FORM", grantedAt: new Date("2026-11-24T09:00:00.000Z"), unsubscribedAt: null };
  assert.equal(isConsentCurrentlyValid(ok, now), true);
  assert.equal(isConsentCurrentlyValid({ ...ok, grantedAt: now }, now), true, "granted exactly now");
  assert.equal(isConsentCurrentlyValid({ ...ok, unsubscribedAt: new Date("2026-11-24T09:30:00.000Z") }, now), false);
  assert.equal(isConsentCurrentlyValid({ ...ok, source: "CHECKOUT_PROGRESS" }, now), false);
  assert.equal(isConsentCurrentlyValid({ ...ok, source: null }, now), false);
  assert.equal(isConsentCurrentlyValid({ ...ok, grantedAt: new Date("2026-11-24T10:00:00.001Z") }, now), false, "future-dated");
  assert.equal(isConsentCurrentlyValid({ ...ok, grantedAt: new Date("nope") }, now), false);
  assert.equal(isConsentCurrentlyValid({ ...ok, grantedAt: "2026-11-24T09:00:00Z" }, now), false, "not a Date");
  assert.equal(isConsentCurrentlyValid({ ...ok, grantedAt: undefined }, now), false);
});

test("the new skip reason is in the fixed vocabulary, and the rules module is pure and never reads checkout-progress consent", () => {
  assert.ok((MARKETING_SKIP_REASONS as readonly string[]).includes("unverifiable"));
  const src = readFileSync(new URL("../../src/lib/email/marketing-rules.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(src, /^\/\*\*[\s\S]*PURE/m);
  assert.ok(!/prisma|fetch\(|process\.env|import /.test(code), "no database, network, environment or imports");
  assert.ok(!/consentAt|incompleteCheckout/i.test(code));
});
