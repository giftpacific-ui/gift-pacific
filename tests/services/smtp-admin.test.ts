/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb, runAs, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { adminCheckSmtpConnection, adminSendSmtpTestEmail, getSmtpAdminStatus } from "@/server/services/admin-smtp.service";
import { checkSmtpConnectionAction, sendSmtpTestEmailAction } from "@/server/actions/admin-smtp.actions";
import { sendSmtpMail } from "@/lib/email/smtp";
import { validateRecipientEmail } from "@/lib/email/config";

const PASS = "abcd efgh ijkl mnop";
const RAW_PASS = "abcdefghijklmnop";
const good = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "shop@gmail.com", SMTP_PASS: PASS, SMTP_FROM_NAME: "GiftPacific", SMTP_FROM_EMAIL: "" };

let db: FakeDb;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["RATE_LIMIT_ENABLED", "SMTP_USER", "SMTP_PASS", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_FROM_NAME", "SMTP_FROM_EMAIL"];
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  process.env.RATE_LIMIT_ENABLED = "false";
  db = freshDb();
  seedAdmins(db);
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer", role: "CUSTOMER", isActive: true });
  db.insert("user", { id: "adm-off", email: "off@staff.test", name: "Off", role: "ADMIN", isActive: false });
});
afterEach(() => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

type Sent = { mail?: any; opened: number; closed: number };
const fakeTransport = (behaviour: (mail: any) => Promise<any>, seen: Sent = { opened: 0, closed: 0 }) =>
  Object.assign((options: Record<string, unknown>) => {
    seen.opened++;
    (seen as any).options = options;
    return { verify: async () => true, sendMail: async (mail: any) => { seen.mail = mail; return behaviour(mail); }, close: () => { seen.closed++; } };
  }, { seen });
const accepts = async (mail: any) => ({ messageId: "<id@gmail.com>", accepted: [mail.to], rejected: [] });
const silenced = async <T>(fn: () => Promise<T>) => { const w = console.warn, i = console.info; console.warn = () => {}; console.info = () => {}; try { return await fn(); } finally { console.warn = w; console.info = i; } };

// ---- status DTO: no secrets ------------------------------------------------------------------------------------------------------------
test("status: not configured / invalid / configured; sender shown, login masked, password never present", () => {
  assert.deepEqual(getSmtpAdminStatus({}), { state: "not_configured", senderName: null, senderEmail: null, host: null, port: null, encryption: null, loginUser: null, passwordSet: false, problems: [], warnings: [] });
  const bad = getSmtpAdminStatus({ ...good, SMTP_PORT: "99999" });
  assert.equal(bad.state, "invalid"); assert.match(bad.problems.join(), /SMTP_PORT/);
  const ok = getSmtpAdminStatus({ ...good, SMTP_FROM_NAME: "Gift Shop", SMTP_FROM_EMAIL: "" });
  assert.equal(ok.state, "configured");
  assert.equal(ok.senderName, "Gift Shop"); assert.equal(ok.senderEmail, "shop@gmail.com");
  assert.equal(ok.host, "smtp.gmail.com"); assert.equal(ok.port, 587); assert.equal(ok.encryption, "STARTTLS");
  assert.equal(ok.loginUser, "s***@gmail.com"); assert.equal(ok.passwordSet, true);
  const ssl = getSmtpAdminStatus({ ...good, SMTP_PORT: "465", SMTP_SECURE: "true" });
  assert.equal(ssl.encryption, "SSL/TLS");
});

test("status: the serialised DTO (what a page prop or API response would carry) never contains the password in any form", () => {
  for (const env of [good, { ...good, SMTP_PASS: "supersecretpassword99", SMTP_PORT: "70000" }, { ...good, SMTP_PASS: "supersecretpassword99" }]) {
    const json = JSON.stringify(getSmtpAdminStatus(env));
    assert.doesNotMatch(json, /abcd ?efgh ?ijkl ?mnop|supersecretpassword99/);
    assert.doesNotMatch(json, /"pass"|"password":"/i);
  }
  assert.ok(!Object.keys(getSmtpAdminStatus(good)).some((k) => /^pass$|^password$|secret/i.test(k)));
});

// ---- authorisation ---------------------------------------------------------------------------------------------------------------------
test("actions refuse anonymous visitors and customers before doing anything", async () => {
  process.env.SMTP_USER = "shop@gmail.com"; process.env.SMTP_PASS = PASS;
  for (const who of [null, { sub: "cust-9" }] as const) {
    await assert.rejects(runAs(who, () => sendSmtpTestEmailAction("a@b.co")), /FORBIDDEN/);
    await assert.rejects(runAs(who, () => checkSmtpConnectionAction()), /FORBIDDEN/);
  }
});

test("services re-check the admin in the database: unknown, customer and deactivated ids are refused and nothing is sent or audited", async () => {
  const seen: Sent = { opened: 0, closed: 0 };
  for (const id of [undefined, null, "", "ghost", "cust-9", "adm-off"]) {
    const a = await adminSendSmtpTestEmail(id, "a@b.co", good, fakeTransport(accepts, seen));
    assert.equal(a.success, false); assert.equal((a as any).code, "forbidden");
    const b = await adminCheckSmtpConnection(id, good, fakeTransport(accepts, seen));
    assert.equal((b as any).code, "forbidden");
  }
  assert.equal(seen.opened, 0);
  assert.equal(db.rows("adminAuditEvent").length, 0);
});

test("an admin session reaching the real action with SMTP off gets a clear 'not configured' failure (no crash, no connection)", async () => {
  const r = await runAs("admin", () => sendSmtpTestEmailAction("a@b.co"));
  assert.equal(r.success, false); assert.equal((r as any).code, "not_configured");
  assert.match(r.message, /SMTP_USER and SMTP_PASS/);
  const c = await runAs("admin", () => checkSmtpConnectionAction());
  assert.equal((c as any).code, "not_configured");
});

// ---- sending ---------------------------------------------------------------------------------------------------------------------------
test("test e-mail: success goes through the central sender with the configured From, one recipient, fixed content, and closes the connection", async () => {
  const seen: Sent = { opened: 0, closed: 0 };
  const r = await adminSendSmtpTestEmail("a1", "  Owner@Example.com ", { ...good, SMTP_FROM_NAME: "Gift Pacific" }, fakeTransport(accepts, seen));
  assert.equal(r.success, true);
  assert.match(r.message, /accepted the test e-mail for Owner@Example\.com/);
  assert.deepEqual(seen.mail.from, { name: "Gift Pacific", address: "shop@gmail.com" });
  assert.equal(seen.mail.to, "Owner@Example.com");
  assert.match(seen.mail.subject, /^Gift Pacific: SMTP test email$/);
  assert.match(seen.mail.text, /test e-mail/); assert.match(seen.mail.html, /<strong>Gift Pacific<\/strong>/);
  assert.equal(seen.closed, 1); assert.equal(seen.opened, 1);
  assert.equal((seen as any).options.requireTLS, true, "uses the central TLS-required transport options");
  assert.doesNotMatch(JSON.stringify(r), /abcdefghijklmnop|abcd efgh|shop@gmail/);
  assert.doesNotMatch(seen.mail.text + seen.mail.html, /abcdefghijklmnop/);
});

test("test e-mail: the sender name is HTML-escaped in the body", async () => {
  const seen: Sent = { opened: 0, closed: 0 };
  await adminSendSmtpTestEmail("a1", "a@b.co", { ...good, SMTP_FROM_NAME: `<b>"X"</b> & Co` }, fakeTransport(accepts, seen));
  assert.doesNotMatch(seen.mail.html, /<b>/); assert.match(seen.mail.html, /&#60;b&#62;/);
});

test("test e-mail: invalid recipients are rejected before any connection (empty, two addresses, header injection, no domain, too long, non-string)", async () => {
  const seen: Sent = { opened: 0, closed: 0 };
  for (const bad of ["", "   ", "a@b.co, c@d.co", "a@b.co;c@d.co", "a@b.co\r\nBcc: x@y.z", "not-an-email", "a@b", `${"x".repeat(250)}@b.co`, null, 42, { a: 1 }]) {
    const r = await adminSendSmtpTestEmail("a1", bad, good, fakeTransport(accepts, seen));
    assert.equal(r.success, false, String(bad)); assert.equal((r as any).code, "invalid_recipient");
  }
  assert.equal(seen.opened, 0); assert.equal(db.rows("adminAuditEvent").length, 0);
  assert.equal(validateRecipientEmail("x@y.zz").ok, true);
});

test("test e-mail: not configured and invalid settings fail clearly and never open a connection; problems name variables, not values", async () => {
  const seen: Sent = { opened: 0, closed: 0 };
  const a = await adminSendSmtpTestEmail("a1", "a@b.co", {}, fakeTransport(accepts, seen));
  assert.equal((a as any).code, "not_configured");
  const b = await adminSendSmtpTestEmail("a1", "a@b.co", { ...good, SMTP_PASS: "topsecretvalue123", SMTP_PORT: "99999" }, fakeTransport(accepts, seen));
  assert.equal((b as any).code, "invalid_config"); assert.match(b.message, /SMTP_PORT/);
  assert.doesNotMatch(JSON.stringify(b), /topsecretvalue123/);
  assert.equal(seen.opened, 0);
});

test("test e-mail: every failure maps to a fixed message; raw server text, credentials and the login are never returned or logged", async () => {
  const cases: [any, string][] = [
    [{ code: "EAUTH", responseCode: 535, message: "Invalid login: 535 5.7.8 Username and Password not accepted for shop@gmail.com abcdefghijklmnop" }, "auth_failed"],
    [{ code: "EENVELOPE", message: "Can't send mail - all recipients were rejected: 550 5.1.1 nobody@x.co" }, "recipient_rejected"],
    [{ code: "EMESSAGE", responseCode: 550, message: "550 5.4.5 Daily user sending quota exceeded shop@gmail.com" }, "send_rejected"],
    [{ responseCode: 421, message: "421 4.7.0 Try again later" }, "send_rejected"],
    [{ code: "ETIMEDOUT", message: "Connection timeout" }, "timeout"],
    [{ code: "EDNS", message: "getaddrinfo ENOTFOUND smtp.gmail.com" }, "dns_failed"],
    [{ code: "ECONNECTION", message: "connect ECONNREFUSED 1.2.3.4:587" }, "connection_failed"],
    [{ code: "ESOCKET", message: "wrong version number (ssl3_get_record)" }, "tls_failed"],
    [new Error("boom"), "unknown"],
  ];
  const logged: string[] = [];
  const w = console.warn, i = console.info; console.warn = (...a: unknown[]) => { logged.push(a.join(" ")); }; console.info = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    for (const [err, code] of cases) {
      const seen: Sent = { opened: 0, closed: 0 };
      const r: any = await adminSendSmtpTestEmail("a1", "nobody@x.co", good, fakeTransport(async () => { throw err; }, seen));
      assert.equal(r.success, false, code); assert.equal(r.code, code);
      assert.equal(seen.closed, 1, "connection closed after a failure");
      assert.doesNotMatch(JSON.stringify(r), /shop@gmail|abcdefghijklmnop|Username and Password|getaddrinfo|ECONN|1\.2\.3\.4|quota|nobody@x/);
    }
  } finally { console.warn = w; console.info = i; }
  assert.doesNotMatch(logged.join("\n"), /shop@gmail|abcdefghijklmnop|Username and Password|getaddrinfo|nobody@x|1\.2\.3\.4/);
});

test("test e-mail: a server that accepts nobody (or lists a rejected recipient) is a failure, never a success", async () => {
  const none = await silenced(() => adminSendSmtpTestEmail("a1", "a@b.co", good, fakeTransport(async () => ({ accepted: [], rejected: ["a@b.co"] }))));
  assert.equal((none as any).code, "recipient_rejected");
  const partial = await silenced(() => adminSendSmtpTestEmail("a1", "a@b.co", good, fakeTransport(async () => ({ accepted: ["a@b.co"], rejected: ["x@y.z"] }))));
  assert.equal(partial.success, false);
  const empty = await silenced(() => adminSendSmtpTestEmail("a1", "a@b.co", good, fakeTransport(async () => ({}))));
  assert.equal(empty.success, false, "a response that does not confirm acceptance is not reported as success");
});

test("sendSmtpMail refuses a multi-line subject and a transport that cannot send", async () => {
  const a = await sendSmtpMail({ to: "a@b.co", subject: "x\r\nBcc: y@z.co", text: "t" }, good, fakeTransport(accepts));
  assert.equal(a.ok, false);
  const b = await silenced(() => sendSmtpMail({ to: "a@b.co", subject: "ok", text: "t" }, good, () => ({ verify: async () => true, close() {} })));
  assert.equal(b.ok, false); assert.equal((b as any).code, "unknown");
});

// ---- connection check ------------------------------------------------------------------------------------------------------------------
test("connection check: success sends no mail; failure returns a fixed message", async () => {
  const seen: Sent = { opened: 0, closed: 0 };
  const r = await adminCheckSmtpConnection("a1", good, fakeTransport(accepts, seen));
  assert.equal(r.success, true); assert.match(r.message, /No e-mail was sent/); assert.equal(seen.mail, undefined);
  const f = await silenced(() => adminCheckSmtpConnection("a1", good, () => ({ verify: async () => { throw { code: "EAUTH", responseCode: 535, message: "bad shop@gmail.com abcdefghijklmnop" }; }, close() {} })));
  assert.equal(f.success, false); assert.equal((f as any).code, "auth_failed");
  assert.doesNotMatch(JSON.stringify(f), /shop@gmail|abcdefghijklmnop/);
});

// ---- audit + rate limit ----------------------------------------------------------------------------------------------------------------
test("audit: who tested, the MASKED recipient and the outcome are recorded; never the password or the full address", async () => {
  await adminSendSmtpTestEmail("a1", "owner@example.com", good, fakeTransport(accepts));
  await silenced(() => adminSendSmtpTestEmail("a2", "owner@example.com", good, fakeTransport(async () => { throw { code: "EAUTH", responseCode: 535 }; })));
  const rows = db.rows("adminAuditEvent").filter((e: any) => e.action === "SMTP_TEST_EMAIL");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((e: any) => [e.actorId, e.detail.outcome]), [["a1", "accepted"], ["a2", "auth_failed"]]);
  assert.equal(rows[0].detail.recipient, "o***@example.com");
  assert.doesNotMatch(JSON.stringify(rows), /owner@example|abcdefghijklmnop/);
});

test("rate limit: the 11th test e-mail in an hour is refused without sending (limits are per admin)", async () => {
  process.env.RATE_LIMIT_ENABLED = "true"; process.env.AUTH_SECRET = "x".repeat(40);
  const counts = new Map<string, number>();
  (db as any).$queryRaw = async (_s: TemplateStringsArray, ...v: unknown[]) => { const k = String(v[0]); counts.set(k, (counts.get(k) ?? 0) + 1); return [{ count: counts.get(k) }]; };
  const prisma = (await import("@/lib/db/prisma")).prisma as any; prisma.$queryRaw = (db as any).$queryRaw;
  const seen: Sent = { opened: 0, closed: 0 };
  for (let n = 0; n < 10; n++) assert.equal((await adminSendSmtpTestEmail("a1", "a@b.co", good, fakeTransport(accepts, seen))).success, true);
  const eleventh = await adminSendSmtpTestEmail("a1", "a@b.co", good, fakeTransport(accepts, seen));
  assert.equal(eleventh.success, false); assert.equal((eleventh as any).code, "throttled");
  assert.equal(seen.opened, 10);
  assert.equal((await adminSendSmtpTestEmail("a2", "a@b.co", good, fakeTransport(accepts, seen))).success, true, "another admin has their own allowance");
});

// ---- architecture guards ---------------------------------------------------------------------------------------------------------------
test("the admin panel is a client component that never imports the SMTP modules or reads SMTP env; the page passes only the safe DTO", () => {
  const panel = readFileSync("src/features/admin/smtp-settings-panel.tsx", "utf8");
  assert.match(panel, /^"use client"/);
  assert.doesNotMatch(panel, /@\/lib\/email|process\.env/);
  const page = readFileSync("src/app/admin/(dashboard)/settings/page.tsx", "utf8");
  assert.match(page, /<SmtpSettingsPanel status=\{getSmtpAdminStatus\(\)\}/);
  const actions = readFileSync("src/server/actions/admin-smtp.actions.ts", "utf8");
  assert.match(actions, /^"use server"/);
  assert.ok(actions.indexOf("requireAdmin()") < actions.indexOf("adminCheckSmtpConnection(") && actions.indexOf("requireAdmin()") < actions.indexOf("adminSendSmtpTestEmail("));
  assert.equal((actions.match(/await requireAdmin\(\)/g) ?? []).length, 2, "both exported actions authorise first");
  const service = readFileSync("src/server/services/admin-smtp.service.ts", "utf8");
  assert.doesNotMatch(service.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""), /\.\.\.\s*(state\.)?config|JSON\.stringify\(\s*(state|c)\b|pass:/, "the config (with the password) is never spread or serialised");
});
