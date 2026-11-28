/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prompt 11: the PURE unsubscribe building blocks (no database): stable token derivation, secret and base-URL validation, URL validation (no open
 * redirect), List-Unsubscribe headers (RFC 8058) and their injection resistance, the one-click body rule, log redaction, the template renderer's
 * handling of {{unsubscribeUrl}}, the environment checks, and the guarantees about what the code never does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  createUnsubscribeLink, deriveUnsubscribeToken, readUnsubscribeBaseUrl, readUnsubscribeConfig, readUnsubscribeSecret, unsubscribeHeadersFor,
  unsubscribeTokensMatch, validateUnsubscribeUrl, verifyUnsubscribeToken,
} from "@/lib/email/unsubscribe";
import {
  buildListUnsubscribeHeaders, checkUnsubscribeUrlShape, isOneClickUnsubscribeBody, isValidListUnsubscribeHeaders, LIST_UNSUBSCRIBE_POST_VALUE,
} from "@/lib/email/list-unsubscribe";
import { redactUnsubscribePath, UNSUBSCRIBE_ROUTE_PREFIX } from "@/lib/email/unsubscribe-path";
import { renderEmailTemplate, validateTemplateContent } from "@/lib/email/template-rules";
import { unsubscribePlaceholderProblems } from "@/lib/email/campaign-dispatch-rules";
import { findProductionConfigProblems } from "@/lib/production-checks";
import { hashUnsubscribeToken } from "@/lib/email/marketing";

const SECRET = "test-only-unsubscribe-secret-Zq8Lm3Vx7Rb2Nc5Kd9Wp4Ty6";
const PROD = { EMAIL_UNSUBSCRIBE_SECRET: SECRET, NEXT_PUBLIC_APP_URL: "https://shop.example.com", NODE_ENV: "production" };
const TOKEN = "A".repeat(43);
const URL_OK = `https://shop.example.com${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`;

// -------------------------------------------------------------------------------------------------------------------------------- the token

test("the token is stable: the same contact and secret always give the same token, for any number of 'campaigns'", () => {
  const a = deriveUnsubscribeToken(SECRET, "contact_1")!;
  for (let i = 0; i < 50; i++) assert.equal(deriveUnsubscribeToken(SECRET, "contact_1"), a);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/, "43 base64url characters: exactly what the P07 hash column / hashUnsubscribeToken accept");
  assert.ok(hashUnsubscribeToken(a), "so the existing P07 SHA-256 lookup index can be used unchanged");
});

test("tokens are per contact and per secret: nobody's token is anybody else's, and a different secret revokes every link", () => {
  const a = deriveUnsubscribeToken(SECRET, "contact_1")!;
  const b = deriveUnsubscribeToken(SECRET, "contact_2")!;
  assert.notEqual(a, b);
  assert.notEqual(deriveUnsubscribeToken(SECRET + "x", "contact_1"), a, "rotating the secret is the one deliberate way to revoke links");
  assert.ok(verifyUnsubscribeToken(SECRET, "contact_1", a));
  assert.ok(!verifyUnsubscribeToken(SECRET, "contact_2", a), "contact 1's token does not verify for contact 2");
  assert.ok(!verifyUnsubscribeToken(SECRET + "x", "contact_1", a), "nor under another secret");
});

test("the token does not contain the contact id, and an unusable id or secret gives no token at all", () => {
  const t = deriveUnsubscribeToken(SECRET, "emailContact_42")!;
  assert.ok(!t.includes("emailContact") && !t.includes("42"));
  for (const bad of ["", "a b", "a/b", "x".repeat(65), null, undefined, 7, {}]) assert.equal(deriveUnsubscribeToken(SECRET, bad), null, String(bad));
  for (const weak of ["", "short", "x".repeat(31)]) assert.equal(deriveUnsubscribeToken(weak, "c1"), null);
});

test("verification rejects malformed, forged, truncated, padded and wrong-type tokens (constant-time compare on well-formed ones only)", () => {
  const good = deriveUnsubscribeToken(SECRET, "c1")!;
  const flipped = (good[0] === "A" ? "B" : "A") + good.slice(1);
  for (const bad of [flipped, good.slice(1), good + "A", good + "=", `${good.slice(0, 42)}!`, "", " ".repeat(43), null, undefined, 5, {}, [good]]) {
    assert.ok(!verifyUnsubscribeToken(SECRET, "c1", bad), String(bad));
    assert.ok(!unsubscribeTokensMatch(good, bad), String(bad));
  }
  assert.ok(unsubscribeTokensMatch(good, good));
  const src = readFileSync(new URL("../../src/lib/email/unsubscribe.ts", import.meta.url), "utf8");
  assert.match(src, /timingSafeEqual/, "constant-time signature comparison");
  assert.ok(!/(?:expected|supplied|token)\s*===?\s*(?:expected|supplied|token)\b/.test(src.replace(/\/\/.*$/gm, "")), "no plain === between two tokens");
});

// ------------------------------------------------------------------------------------------------------------------------------------ secret

test("a missing secret fails safely: no token, no URL, no fallback to another secret", () => {
  for (const env of [{}, { EMAIL_UNSUBSCRIBE_SECRET: "" }, { EMAIL_UNSUBSCRIBE_SECRET: "   " }]) {
    assert.deepEqual(readUnsubscribeSecret(env), { ok: false, reason: "secret_missing" });
    assert.deepEqual(readUnsubscribeConfig({ ...env, NEXT_PUBLIC_APP_URL: "https://shop.example.com" }), { ok: false, reason: "secret_missing" });
  }
  // Other secrets in the environment are NEVER used instead.
  const others = { AUTH_SECRET: "a".repeat(10) + SECRET, CRON_SECRET: SECRET + "cron", SMTP_PASS: "abcdefghijklmnop" };
  assert.deepEqual(readUnsubscribeSecret(others), { ok: false, reason: "secret_missing" });
});

test("weak secrets are refused: too short, placeholder, one repeated character, control characters", () => {
  for (const weak of ["short", "x".repeat(31), "a".repeat(64), "replace-with-a-long-random-string", `${"k".repeat(40)}\n`.replace(/\n$/, "\u0001")]) {
    assert.deepEqual(readUnsubscribeSecret({ EMAIL_UNSUBSCRIBE_SECRET: weak }), { ok: false, reason: "secret_weak" }, weak.slice(0, 12));
  }
  assert.deepEqual(readUnsubscribeSecret({ EMAIL_UNSUBSCRIBE_SECRET: ` ${SECRET} ` }), { ok: true, secret: SECRET }, "surrounding whitespace is trimmed");
});

test("the secret must be its own: reusing AUTH_SECRET, CRON_SECRET, the SMTP password or a public value is refused", () => {
  for (const reuse of [{ AUTH_SECRET: SECRET }, { CRON_SECRET: SECRET }, { SMTP_PASS: SECRET }, { NEXT_PUBLIC_SOMETHING: SECRET }]) {
    assert.deepEqual(readUnsubscribeSecret({ EMAIL_UNSUBSCRIBE_SECRET: SECRET, ...reuse }), { ok: false, reason: "secret_reused" }, Object.keys(reuse)[0]);
  }
  assert.ok(readUnsubscribeSecret({ EMAIL_UNSUBSCRIBE_SECRET: SECRET, AUTH_SECRET: "different-auth-secret-value-0123456789abcd" }).ok);
});

test("no failure reason, message or result ever contains the secret", () => {
  const env = { EMAIL_UNSUBSCRIBE_SECRET: SECRET, AUTH_SECRET: SECRET };
  assert.ok(!JSON.stringify(readUnsubscribeSecret(env)).includes(SECRET));
  const problems = findProductionConfigProblems({ NODE_ENV: "production", AUTH_SECRET: SECRET, NEXT_PUBLIC_APP_URL: "https://shop.example.com", DATABASE_URL: "x", EMAIL_UNSUBSCRIBE_SECRET: SECRET });
  assert.ok(!JSON.stringify(problems).includes(SECRET));
});

// -------------------------------------------------------------------------------------------------------------------------------- base URL

test("base URL: production needs an https origin that is not localhost; no credentials, path, query or fragment", () => {
  assert.deepEqual(readUnsubscribeBaseUrl(PROD), { ok: true, origin: "https://shop.example.com" });
  assert.deepEqual(readUnsubscribeBaseUrl({ ...PROD, NEXT_PUBLIC_APP_URL: "https://shop.example.com/" }), { ok: true, origin: "https://shop.example.com" });
  assert.deepEqual(readUnsubscribeBaseUrl({ ...PROD, NEXT_PUBLIC_APP_URL: "https://SHOP.example.com:8443" }), { ok: true, origin: "https://shop.example.com:8443" });
  for (const bad of ["", "http://shop.example.com", "https://localhost", "https://127.0.0.1", "http://localhost:3000", "https://user:pw@shop.example.com", "https://shop.example.com/shop",
    "https://shop.example.com/?a=1", "https://shop.example.com/#x", "ftp://shop.example.com", "javascript:alert(1)", "not a url", "https://shop.example.com\r\nBcc: x", "//shop.example.com"]) {
    assert.deepEqual(readUnsubscribeBaseUrl({ ...PROD, NEXT_PUBLIC_APP_URL: bad }), { ok: false, reason: "base_url_invalid" }, JSON.stringify(bad));
  }
  assert.deepEqual(readUnsubscribeBaseUrl({ NODE_ENV: "production" }), { ok: false, reason: "base_url_invalid" }, "no default in production");
});

test("base URL outside production: http only for localhost; a missing value is the usual localhost default", () => {
  assert.deepEqual(readUnsubscribeBaseUrl({ NODE_ENV: "development" }), { ok: true, origin: "http://localhost:3000" });
  assert.deepEqual(readUnsubscribeBaseUrl({ NODE_ENV: "development", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:4000" }), { ok: true, origin: "http://127.0.0.1:4000" });
  assert.deepEqual(readUnsubscribeBaseUrl({ NODE_ENV: "development", NEXT_PUBLIC_APP_URL: "http://shop.example.com" }), { ok: false, reason: "base_url_invalid" });
  assert.deepEqual(readUnsubscribeBaseUrl({ NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "https://staging.example.com" }), { ok: true, origin: "https://staging.example.com" });
});

// ------------------------------------------------------------------------------------------------------------------------------------- url

test("the unsubscribe URL is built from the configured origin, the fixed route and the token only (no id, no address)", () => {
  const cfg = readUnsubscribeConfig(PROD);
  assert.ok(cfg.ok);
  if (!cfg.ok) return;
  const link = createUnsubscribeLink(cfg, "contact_1", PROD);
  assert.ok(link.ok);
  if (!link.ok) return;
  assert.equal(link.url, `https://shop.example.com${UNSUBSCRIBE_ROUTE_PREFIX}${deriveUnsubscribeToken(SECRET, "contact_1")}`);
  assert.ok(!link.url.includes("contact_1"));
  assert.equal(link.tokenHash, hashUnsubscribeToken(deriveUnsubscribeToken(SECRET, "contact_1")));
  assert.ok(!JSON.stringify(link).replace(link.url, "").includes(deriveUnsubscribeToken(SECRET, "contact_1")!), "the token appears only inside the URL, never as a field of its own");
  assert.deepEqual(createUnsubscribeLink(cfg, "bad id", PROD), { ok: false, reason: "invalid_contact" });
});

test("URL validation: only our own origin, our own route and a well-formed token pass (no open redirect, no foreign host, no extras)", () => {
  assert.ok(validateUnsubscribeUrl(URL_OK, PROD).ok);
  const bad = [
    `https://evil.example.com${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`, `https://shop.example.com.evil.com${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`,
    `https://shop.example.com@evil.com${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`, `https://user:pw@shop.example.com${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`,
    `http://shop.example.com${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`, `//evil.com${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`, `${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`,
    `${URL_OK}?next=https://evil.com`, `${URL_OK}#x`, `${URL_OK}/`, `${URL_OK} `, ` ${URL_OK}`, `${URL_OK}\r\nBcc: x@y.z`, `${URL_OK}>, <https://evil.com`,
    `https://shop.example.com/api/email/unsubscribe/${"A".repeat(42)}`, `https://shop.example.com/api/email/unsubscribe/${"A".repeat(44)}`,
    `https://shop.example.com/api/email/unsubscribe/../../${TOKEN}`, `https://shop.example.com/other/${TOKEN}`, `https://shop.example.com${UNSUBSCRIBE_ROUTE_PREFIX}${"A".repeat(42)}%2e`,
    `https://SHOP.example.com${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`, `javascript:alert(1)`, "", null, undefined, 5, {}, `https://shop.example.com${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`.repeat(30),
  ];
  for (const u of bad) assert.ok(!validateUnsubscribeUrl(u, PROD).ok, String(u).slice(0, 80));
  assert.ok(!validateUnsubscribeUrl(URL_OK, { ...PROD, NEXT_PUBLIC_APP_URL: "https://other.example.com" }).ok, "a URL of another origin than the configured one");
  assert.ok(!validateUnsubscribeUrl(URL_OK, { ...PROD, NEXT_PUBLIC_APP_URL: "" }).ok, "an unusable configuration validates nothing");
});

// --------------------------------------------------------------------------------------------------------------------------------- headers

test("List-Unsubscribe headers: exactly the RFC 8058 pair for a validated HTTPS URL", () => {
  const r = buildListUnsubscribeHeaders(URL_OK, "production");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.headers, { "List-Unsubscribe": `<${URL_OK}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.equal(LIST_UNSUBSCRIBE_POST_VALUE, "List-Unsubscribe=One-Click");
  assert.ok(isValidListUnsubscribeHeaders(r.headers, "production"));
  const v = validateUnsubscribeUrl(URL_OK, PROD);
  assert.ok(v.ok && unsubscribeHeadersFor(v.url, PROD).ok);
});

test("headers only ever carry validated https URLs: http, mailto, javascript, credentials, queries, lists and non-ASCII are refused", () => {
  for (const u of ["http://shop.example.com/x", "mailto:unsub@shop.example.com", "javascript:alert(1)", "ftp://x.example.com/a", "https://u:p@shop.example.com/a", `${URL_OK}?a=1`,
    `${URL_OK}#f`, `${URL_OK}, <mailto:a@b.c>`, "https://shop.example.com/ünï", "https://localhost/api/x", "", null, 3]) {
    assert.ok(!buildListUnsubscribeHeaders(u, "production").ok, String(u));
  }
  assert.ok(!buildListUnsubscribeHeaders("http://localhost:3000/api/email/unsubscribe/x", "production").ok, "http is never accepted in production");
  assert.ok(buildListUnsubscribeHeaders(`http://localhost:3000${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`, "development").ok, "local development only: http to localhost");
  assert.ok(!buildListUnsubscribeHeaders("http://shop.example.com/x", "development").ok, "...and never http to a real host");
});

test("header injection is rejected: CR, LF, NUL, tab, space, angle brackets, quotes and a smuggled second header never pass", () => {
  for (const evil of ["\r\nBcc: attacker@evil.com", "\nX-Injected: 1", "\r", "\n", "\u0000", "\t", " ", "<", ">", '"', "'", "\\", "`", "\u2028", "%0d%0a"]) {
    const u = `${URL_OK}${evil}`;
    const built = buildListUnsubscribeHeaders(u, "production");
    if (built.ok) assert.ok(!/[\r\n\u0000]/.test(JSON.stringify(Object.values(built.headers)).replace(/\\r|\\n|\\u0000/g, "X!")) || false);
    // Everything except a purely percent-encoded sequence (a literal, harmless path character that the route's token check then refuses) is refused outright.
    if (evil !== "%0d%0a") assert.ok(!built.ok, JSON.stringify(evil));
  }
  const good = buildListUnsubscribeHeaders(URL_OK, "production");
  assert.ok(good.ok);
  if (!good.ok) return;
  const tampered = [
    { ...good.headers, "X-Extra": "1" }, { "List-Unsubscribe": good.headers["List-Unsubscribe"] }, { ...good.headers, "List-Unsubscribe": `<${URL_OK}>\r\nBcc: x@y.z` },
    { ...good.headers, "List-Unsubscribe": URL_OK }, { ...good.headers, "List-Unsubscribe": `<${URL_OK}><https://evil.com>` }, { ...good.headers, "List-Unsubscribe-Post": "List-Unsubscribe=Yes" },
    { ...good.headers, "List-Unsubscribe": "<http://shop.example.com/x>" }, null, [], "x", 7,
  ];
  for (const h of tampered) assert.ok(!isValidListUnsubscribeHeaders(h, "production"), JSON.stringify(h)?.slice(0, 60));
});

test("URL shape: canonical form only, visible ASCII, bounded length", () => {
  assert.ok(checkUnsubscribeUrlShape(URL_OK, "production").ok);
  assert.ok(!checkUnsubscribeUrlShape("https://shop.example.com/a/../b", "production").ok, "non-canonical (dot segments)");
  assert.ok(!checkUnsubscribeUrlShape(`https://shop.example.com/${"a".repeat(2100)}`, "production").ok, "over 2048 characters");
  assert.ok(!checkUnsubscribeUrlShape("HTTPS://shop.example.com/a", "production").ok, "not canonical");
});

// ----------------------------------------------------------------------------------------------------------------------------- one-click body

test("RFC 8058 one-click body: the exact pair, form-encoded or multipart; nothing else counts", () => {
  const form = "application/x-www-form-urlencoded";
  assert.ok(isOneClickUnsubscribeBody("List-Unsubscribe=One-Click", form));
  assert.ok(isOneClickUnsubscribeBody("List-Unsubscribe=One-Click", "application/x-www-form-urlencoded; charset=UTF-8"));
  assert.ok(isOneClickUnsubscribeBody("a=b&List-Unsubscribe=One-Click", form), "extra fields are tolerated");
  const multipart = '--b\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--b--\r\n';
  assert.ok(isOneClickUnsubscribeBody(multipart, "multipart/form-data; boundary=b"));
  for (const [body, type] of [["", form], ["List-Unsubscribe=Other", form], ["list-unsubscribe=One-Click", form], ["List-Unsubscribe=one-click", form], ["List-Unsubscribe=One-Click&List-Unsubscribe=One-Click", form],
    ["List-Unsubscribe=One-Click", "application/json"], ["List-Unsubscribe=One-Click", null], ["List-Unsubscribe=One-Click", "text/plain"], ["x".repeat(2000), form],
    [multipart.replace("One-Click", "Nope"), "multipart/form-data"], [multipart, form], [null, form], [undefined, form], [5, form]] as const) {
    assert.ok(!isOneClickUnsubscribeBody(body as never, type as never), `${JSON.stringify(body)?.slice(0, 40)} ${type}`);
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- log redaction

test("the token is removed from request paths before they reach the error log; every other path is untouched", () => {
  assert.equal(redactUnsubscribePath(`${UNSUBSCRIBE_ROUTE_PREFIX}${TOKEN}`), `${UNSUBSCRIBE_ROUTE_PREFIX}[redacted]`);
  assert.equal(redactUnsubscribePath(`${UNSUBSCRIBE_ROUTE_PREFIX}anything/else`), `${UNSUBSCRIBE_ROUTE_PREFIX}[redacted]`);
  assert.equal(redactUnsubscribePath("/api/email/queue"), "/api/email/queue");
  assert.equal(redactUnsubscribePath("/shop"), "/shop");
  const inst = readFileSync(new URL("../../src/instrumentation.ts", import.meta.url), "utf8");
  assert.match(inst, /redactUnsubscribePath\(request\.path/, "instrumentation.ts redacts the path it logs");
});

// ---------------------------------------------------------------------------------------------------------- template integration ({{unsubscribeUrl}})

const TPL = { subject: "Hi {{firstName}}", textBody: "Unsubscribe: {{unsubscribeUrl}}", htmlBody: '<a href="{{unsubscribeUrl}}">Unsubscribe</a>' };

test("{{unsubscribeUrl}} is a supported variable and renders the recipient's URL, HTML-escaped, in text and HTML; other variables are preserved", () => {
  assert.ok(validateTemplateContent(TPL).ok);
  const full = validateTemplateContent({ ...TPL, textBody: "{{customerName}} {{firstName}} {{email}} {{storeName}} {{unsubscribeUrl}}" });
  assert.ok(full.ok && full.variables.join() === "customerName,email,firstName,storeName,unsubscribeUrl");
  const r = renderEmailTemplate(TPL, { firstName: "Eve", unsubscribeUrl: URL_OK });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.textBody, `Unsubscribe: ${URL_OK}`);
  assert.equal(r.htmlBody, `<a href="${URL_OK}">Unsubscribe</a>`);
  assert.equal(r.subject, "Hi Eve");
});

test("the renderer never fills {{unsubscribeUrl}} with an arbitrary value: injection attempts render as empty, and values are never re-expanded", () => {
  for (const evil of ["javascript:alert(1)", "http://evil.example.com/x", `${URL_OK}"><script>x</script>`, `${URL_OK}\r\nBcc: a@b.c`, "//evil.com", "data:text/html,x", `${URL_OK}?next=https://evil.com`, "{{email}}", "", null, undefined, 5 as never]) {
    const r = renderEmailTemplate(TPL, { unsubscribeUrl: evil as never, email: "victim@example.com" });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.textBody, "Unsubscribe: ", JSON.stringify(evil));
    assert.ok(!r.htmlBody!.includes("evil") && !r.htmlBody!.includes("<script") && !r.textBody.includes("victim"), JSON.stringify(evil));
  }
});

test("the campaign needs the placeholder in the text body AND the HTML body, and never in the subject", () => {
  assert.deepEqual(unsubscribePlaceholderProblems({ subject: "s", textBody: "t {{unsubscribeUrl}}", htmlBody: "<a href=\"{{ unsubscribeUrl }}\">u</a>" }), []);
  assert.deepEqual(unsubscribePlaceholderProblems({ subject: "s", textBody: "t {{unsubscribeUrl}}", htmlBody: null }), [], "text only is fine when there is no HTML body");
  assert.deepEqual(unsubscribePlaceholderProblems({ subject: "s", textBody: "t", htmlBody: null }).map((e) => e.code), ["unsubscribe_link_missing"]);
  assert.deepEqual(unsubscribePlaceholderProblems({ subject: "s", textBody: "t {{unsubscribeUrl}}", htmlBody: "<p>no link</p>" }).map((e) => [e.field, e.code]), [["htmlBody", "unsubscribe_link_missing"]]);
  assert.deepEqual(unsubscribePlaceholderProblems({ subject: "s {{unsubscribeUrl}}", textBody: "t {{unsubscribeUrl}}", htmlBody: null }).map((e) => e.code), ["unsubscribe_url_in_subject"]);
  assert.equal(unsubscribePlaceholderProblems({ subject: "s", textBody: "t {{ unsubscribeUrl}}", htmlBody: null }).length, 0, "spaces inside the braces are the existing placeholder syntax");
  assert.equal(unsubscribePlaceholderProblems({ subject: "s", textBody: "unsubscribeUrl and {unsubscribeUrl} and {{unsubscribe}}", htmlBody: null }).length, 1, "look-alikes are not the placeholder");
});

// ------------------------------------------------------------------------------------------------------------------------------ environment

test("production checks: missing secret warns only when e-mail is enabled; weak or reused secrets are critical; a bad base URL is critical", () => {
  const base = { NODE_ENV: "production", AUTH_SECRET: "x".repeat(8) + "Auth-Secret-0123456789abcdefghijkl", NEXT_PUBLIC_APP_URL: "https://shop.example.com", DATABASE_URL: "postgresql://x" };
  const smtp = { SMTP_USER: "shop@gmail.com", SMTP_PASS: "abcdefghijklmnop" };
  const msgs = (env: Record<string, string>) => findProductionConfigProblems(env).filter((p) => /EMAIL_UNSUBSCRIBE_SECRET|unsubscribe links/.test(p.message));
  assert.deepEqual(msgs(base), [], "e-mail off: nothing to report");
  assert.deepEqual(msgs({ ...base, ...smtp }).map((p) => p.severity), ["warning"]);
  assert.deepEqual(msgs({ ...base, ...smtp, EMAIL_UNSUBSCRIBE_SECRET: SECRET }), [], "a good setup reports nothing");
  assert.deepEqual(msgs({ ...base, EMAIL_UNSUBSCRIBE_SECRET: "short" }).map((p) => p.severity), ["critical"]);
  assert.deepEqual(msgs({ ...base, EMAIL_UNSUBSCRIBE_SECRET: base.AUTH_SECRET }).map((p) => p.severity), ["critical"]);
  assert.deepEqual(msgs({ ...base, EMAIL_UNSUBSCRIBE_SECRET: SECRET, NEXT_PUBLIC_APP_URL: "https://shop.example.com/store" }).map((p) => p.severity), ["critical"]);
});

test(".env.example documents the dedicated secret (empty, never a real value) and the instrumentation import chain stays crypto-free", () => {
  const env = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  assert.match(env, /^EMAIL_UNSUBSCRIBE_SECRET=""$/m);
  assert.match(env, /AUTH_SECRET, CRON_SECRET, SMTP_PASS/);
  for (const f of ["unsubscribe-config", "list-unsubscribe", "unsubscribe-path", "unsubscribe-pages"]) {
    const src = readFileSync(new URL(`../../src/lib/email/${f}.ts`, import.meta.url), "utf8");
    assert.ok(!/node:crypto|from "crypto"|prisma|server-only|fetch\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), `${f} must stay pure and crypto-free`);
  }
  const checks = readFileSync(new URL("../../src/lib/production-checks.ts", import.meta.url), "utf8");
  assert.ok(!/email\/unsubscribe"/.test(checks), "production-checks imports only the crypto-free config module");
});

test("nothing in the unsubscribe code logs a token or URL, and it is never imported by client code", () => {
  const files = ["unsubscribe", "unsubscribe-config", "list-unsubscribe", "unsubscribe-path", "unsubscribe-pages"].map((f) => `../../src/lib/email/${f}.ts`);
  files.push("../../src/server/services/email-unsubscribe.service.ts", "../../src/app/api/email/unsubscribe/[token]/route.ts");
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of src.matchAll(/log(?:Server)?(?:Warning|Error|Info)\(([^;]*)\);/g)) assert.ok(!/token|url|email|secret/i.test(m[1].replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, "``")), `${f}: ${m[1].slice(0, 80)}`);
    assert.ok(!/console\.(log|warn|error|info)/.test(src), `${f} must not use console directly`);
  }
  for (const dir of ["features", "components"]) {
    const walk = (p: string): string[] => readdirSync(new URL(p, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${p}/${e.name}`) : [`${p}/${e.name}`]));
    for (const f of walk(`../../src/${dir}`).filter((x) => /\.(ts|tsx)$/.test(x))) assert.ok(!/lib\/email\/unsubscribe|email-unsubscribe\.service/.test(readFileSync(new URL(f, import.meta.url), "utf8")), f);
  }
});
