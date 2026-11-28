/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describeSmtpConfig, parseSmtpConfig } from "@/lib/email/config";
import { buildTransportOptions, classifySmtpError, createSmtpTransport, verifySmtpConnection } from "@/lib/email/smtp";
import { findProductionConfigProblems } from "@/lib/production-checks";

const PASS = "abcd efgh ijkl mnop";
const good = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "shop@gmail.com", SMTP_PASS: PASS, SMTP_FROM_NAME: "GiftPacific", SMTP_FROM_EMAIL: "" };
const ready = (env: Record<string, string>) => { const s = parseSmtpConfig(env); assert.equal(s.status, "ready", JSON.stringify(s)); return s as Extract<ReturnType<typeof parseSmtpConfig>, { status: "ready" }>; };
const problems = (env: Record<string, string>) => { const s = parseSmtpConfig(env); assert.equal(s.status, "invalid", JSON.stringify(s)); return (s as any).problems.join(" | "); };

test("empty SMTP_USER and SMTP_PASS = e-mail simply off (not an error)", () => {
  assert.deepEqual(parseSmtpConfig({}), { status: "not_configured" });
  assert.deepEqual(parseSmtpConfig({ SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_USER: "", SMTP_PASS: "  " }), { status: "not_configured" });
});

test("the .env.example Gmail defaults with credentials filled in are valid; App Password spaces are removed; sender falls back to SMTP_USER", () => {
  const s = ready(good);
  assert.deepEqual(s.config, { host: "smtp.gmail.com", port: 587, secure: false, user: "shop@gmail.com", pass: "abcdefghijklmnop", fromName: "GiftPacific", fromEmail: "shop@gmail.com" });
  assert.deepEqual(s.warnings, []);
  assert.equal(ready({ SMTP_USER: "shop@gmail.com", SMTP_PASS: PASS }).config.host, "smtp.gmail.com", "host/port/secure/name all default");
  assert.equal(ready({ ...good, SMTP_PORT: "465", SMTP_SECURE: "true" }).config.secure, true);
  assert.equal(ready({ SMTP_USER: "shop@gmail.com", SMTP_PASS: PASS, SMTP_PORT: "465" }).config.secure, true, "465 implies SSL when SMTP_SECURE is empty");
});

test("validation: partial config, bad host/port/secure/user/from, port-security mismatch, header injection", () => {
  assert.match(problems({ SMTP_USER: "shop@gmail.com" }), /SMTP_PASS is required/);
  assert.match(problems({ SMTP_PASS: PASS }), /SMTP_USER is required/);
  assert.match(problems({ ...good, SMTP_HOST: "https://smtp.gmail.com" }), /SMTP_HOST/);
  assert.match(problems({ ...good, SMTP_HOST: "smtp.gmail.com:587" }), /SMTP_HOST/);
  for (const port of ["0", "70000", "abc", "58.7", "-1"]) assert.match(problems({ ...good, SMTP_PORT: port }), /SMTP_PORT/);
  assert.match(problems({ ...good, SMTP_SECURE: "yes" }), /SMTP_SECURE/);
  assert.match(problems({ ...good, SMTP_PORT: "465", SMTP_SECURE: "false" }), /465 needs SMTP_SECURE=true/);
  assert.match(problems({ ...good, SMTP_PORT: "587", SMTP_SECURE: "true" }), /587 needs SMTP_SECURE=false/);
  assert.match(problems({ ...good, SMTP_USER: "not-an-email" }), /SMTP_USER/);
  assert.match(problems({ ...good, SMTP_FROM_EMAIL: "a@b.c\r\nBcc: x@y.z" }), /SMTP_FROM_EMAIL/);
  assert.match(problems({ ...good, SMTP_FROM_NAME: "Evil\r\nBcc: x@y.z" }), /SMTP_FROM_NAME/);
  assert.match(problems({ ...good, SMTP_FROM_NAME: "x".repeat(101) }), /SMTP_FROM_NAME/);
  assert.match(problems({ ...good, SMTP_HOST: "smtp.example.com", SMTP_PASS: "abc\ndef" }), /SMTP_PASS/);
  assert.equal(ready({ ...good, SMTP_PASS: "abcdefghijklmnop\n" }).config.pass, "abcdefghijklmnop", "a pasted trailing newline is harmless for Gmail App Passwords");
});

test("warnings: a non-App-Password for Gmail, and a sender Gmail would rewrite", () => {
  assert.match(ready({ ...good, SMTP_PASS: "My-normal-password1" }).warnings.join(), /App Password/);
  assert.match(ready({ ...good, SMTP_FROM_EMAIL: "orders@giftpacific.com" }).warnings.join(), /Send mail as/);
  assert.deepEqual(ready({ ...good, SMTP_FROM_EMAIL: "SHOP@gmail.com" }).warnings, []);
  assert.deepEqual(ready({ ...good, SMTP_HOST: "smtp.example.com", SMTP_PASS: "any pass" , SMTP_FROM_EMAIL: "orders@example.com" }).warnings, [], "non-Gmail hosts are not second-guessed");
});

test("secrets never appear in validation messages, summaries or the transport's logging options", () => {
  const secret = "supersecretpassword99";
  for (const env of [{ ...good, SMTP_PASS: secret, SMTP_PORT: "70000" }, { ...good, SMTP_PASS: secret }, { ...good, SMTP_PASS: secret, SMTP_USER: "bad user" }]) {
    const s = parseSmtpConfig(env);
    assert.doesNotMatch(JSON.stringify(describeSmtpConfig(s)), new RegExp(secret));
    if (s.status === "invalid") assert.doesNotMatch(JSON.stringify(s), new RegExp(secret));
  }
  const d = describeSmtpConfig(parseSmtpConfig(good));
  assert.equal(d.user, "s***@gmail.com");
  assert.equal(d.passwordSet, true);
  assert.doesNotMatch(JSON.stringify(d), /abcdefghijklmnop|abcd efgh/);
  const o = buildTransportOptions(ready(good).config) as any;
  assert.equal(o.logger, false); assert.equal(o.debug, false);
  assert.equal(o.requireTLS, true, "STARTTLS is mandatory on 587");
  assert.equal(buildTransportOptions(ready({ ...good, SMTP_PORT: "465", SMTP_SECURE: "true" }).config).requireTLS, false);
  assert.equal(o.tls.rejectUnauthorized, true);
  assert.ok(o.connectionTimeout <= 10_000 && o.greetingTimeout <= 10_000 && o.socketTimeout <= 15_000);
});

const fakeFactory = (behaviour: () => Promise<unknown>, seen: { options?: any; closed: number } = { closed: 0 }) =>
  Object.assign((options: Record<string, unknown>) => { seen.options = options; return { verify: behaviour, close: () => { seen.closed++; } }; }, { seen });

test("verify: success logs in, sends nothing, closes the connection, returns no credentials", async () => {
  const seen: any = { closed: 0 };
  const r = await verifySmtpConnection(good, fakeFactory(async () => true, seen));
  assert.deepEqual(r, { ok: true, host: "smtp.gmail.com", port: 587 });
  assert.equal(seen.closed, 1);
  assert.equal(seen.options.auth.pass, "abcdefghijklmnop", "the transport itself does get the password");
  assert.doesNotMatch(JSON.stringify(r), /abcdefghijklmnop|shop@gmail/);
});

test("verify: not configured / invalid never open a connection", async () => {
  let created = 0;
  const f = () => { created++; return { verify: async () => true, close() {} }; };
  const a = await verifySmtpConnection({}, f);
  assert.equal(a.ok, false); assert.equal((a as any).code, "not_configured");
  const b = await verifySmtpConnection({ ...good, SMTP_PORT: "9999999" }, f);
  assert.equal((b as any).code, "invalid_config"); assert.match((b as any).problems[0], /SMTP_PORT/);
  assert.equal(created, 0);
  assert.equal(await createSmtpTransport({}, f), null);
});

test("verify: failures map to fixed codes; the raw error text (which can echo credentials) is never returned or logged", async () => {
  const cases: [any, string][] = [
    [{ code: "EAUTH", responseCode: 535, message: "Invalid login: 535 5.7.8 Username and Password not accepted for shop@gmail.com abcdefghijklmnop" }, "auth_failed"],
    [{ responseCode: 534, message: "x" }, "auth_failed"],
    [{ code: "ETIMEDOUT", message: "Connection timeout" }, "timeout"],
    [{ code: "EDNS", message: "getaddrinfo ENOTFOUND smtp.gmail.com" }, "dns_failed"],
    [{ code: "ECONNECTION", message: "connect ECONNREFUSED" }, "connection_failed"],
    [{ code: "ESOCKET", message: "wrong version number (ssl3_get_record)" }, "tls_failed"],
    [{ code: "ESOCKET", message: "socket hang up" }, "connection_failed"],
    [{ code: "MODULE_NOT_FOUND", message: "Cannot find module 'nodemailer'" }, "dependency_missing"],
    [new Error("boom"), "unknown"],
    ["string thrown", "unknown"],
  ];
  const logged: string[] = [];
  const realWarn = console.warn; console.warn = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    for (const [err, code] of cases) {
      const r: any = await verifySmtpConnection(good, fakeFactory(async () => { throw err; }));
      assert.equal(r.ok, false); assert.equal(r.code, code);
      assert.equal(classifySmtpError(err), code);
      assert.doesNotMatch(JSON.stringify(r), /shop@gmail|abcdefghijklmnop|535|getaddrinfo|ECONN/);
    }
  } finally { console.warn = realWarn; }
  assert.equal(logged.length, cases.length);
  assert.doesNotMatch(logged.join("\n"), /shop@gmail|abcdefghijklmnop|Username and Password|getaddrinfo/);
});

test("verify: the connection is closed even when verification throws; a throwing close() is ignored", async () => {
  const seen: any = { closed: 0 };
  const realWarn = console.warn; console.warn = () => {};
  try {
    await verifySmtpConnection(good, fakeFactory(async () => { throw new Error("x"); }, seen));
    assert.equal(seen.closed, 1);
    const r = await verifySmtpConnection(good, () => ({ verify: async () => true, close() { throw new Error("close failed"); } }));
    assert.equal(r.ok, true);
  } finally { console.warn = realWarn; }
});

test("production check reports invalid SMTP settings by variable name only; not configured / valid add nothing", () => {
  const base = { NODE_ENV: "production", AUTH_SECRET: "x".repeat(40), NEXT_PUBLIC_APP_URL: "https://shop.example.com", DATABASE_URL: "postgres://x" };
  const msgs = (e: Record<string, string>) => findProductionConfigProblems({ ...base, ...e }).map((p) => p.message).filter((m) => /SMTP/.test(m));
  assert.deepEqual(msgs({}), []);
  assert.deepEqual(msgs(good), []);
  const bad = msgs({ ...good, SMTP_PASS: "topsecretvalue123", SMTP_PORT: "99999" });
  assert.equal(bad.length, 1);
  assert.match(bad[0], /SMTP_PORT/);
  assert.doesNotMatch(bad[0], /topsecretvalue123/);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

test("credentials stay on the server: no client component, UI folder or NEXT_PUBLIC variable touches the SMTP modules", () => {
  const offenders = walk("src").filter((f) => {
    const src = readFileSync(f, "utf8");
    const importsSmtp = /from\s+["']@\/lib\/email[/"']|process\.env\.SMTP_|env\.SMTP_/.test(src);
    if (!importsSmtp || f.startsWith(path.join("src", "lib", "email"))) return false;
    return /^\s*["']use client["']/m.test(src) || f.startsWith(path.join("src", "features")) || f.startsWith(path.join("src", "components"));
  });
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(readFileSync(".env.example", "utf8"), /NEXT_PUBLIC_SMTP/);
  assert.doesNotMatch(walk("src").map((f) => readFileSync(f, "utf8")).join("\n"), /NEXT_PUBLIC_SMTP/);
});

test(".env.example documents exactly the requested SMTP variables with the requested defaults, and no secret", () => {
  const env = readFileSync(".env.example", "utf8");
  const line = (k: string) => env.split("\n").find((l) => l.startsWith(`${k}=`));
  assert.equal(line("SMTP_HOST"), "SMTP_HOST=smtp.gmail.com");
  assert.equal(line("SMTP_PORT"), "SMTP_PORT=587");
  assert.equal(line("SMTP_SECURE"), "SMTP_SECURE=false");
  assert.equal(line("SMTP_USER"), "SMTP_USER=");
  assert.equal(line("SMTP_PASS"), "SMTP_PASS=");
  assert.equal(line("SMTP_FROM_NAME"), "SMTP_FROM_NAME=GiftPacific");
  assert.equal(line("SMTP_FROM_EMAIL"), "SMTP_FROM_EMAIL=");
  assert.equal(parseSmtpConfig(Object.fromEntries(env.split("\n").filter((l) => /^SMTP_[A-Z_]+=/.test(l)).map((l) => l.split("=") as [string, string]))).status, "not_configured");
});
