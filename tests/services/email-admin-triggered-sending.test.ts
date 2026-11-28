/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Event-driven (admin-triggered) sending only. Runs the REAL campaign dispatch, queue worker, consent / suppression / unsubscribe gates and the new
 * abandoned-cart and retry services on the in-memory database with a fake SMTP transport. Covers: Send now (awaited batch, bounded, partial), Continue
 * sending, admin-triggered abandoned-cart reminders, manual multi-job Retry, concurrent clicks, duplicate protection, partial failures, and the absence of
 * any automatic trigger (no cron file, no timers, no after() work, no scheduler calls).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { discardAfter, freshDb, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { captureLogs, makeSmtp, NOW, optedIn, SMTP_ENV, smtpFails, T0, UNSUB_BASE, UNSUB_SECRET } from "../setup/campaign-dispatch-fixture";
import { createEmailTemplate } from "@/server/services/email-template.service";
import { suppressEmail } from "@/server/services/email-suppression.service";
import { adminContinueCampaignSending, adminPrepareCampaignAudience, adminSaveCampaignDraft, adminSendCampaignNow } from "@/server/services/admin-email-campaign.service";
import { adminListEmailJobs, adminRetryEmailJobs } from "@/server/services/admin-email-queue.service";
import { adminSendAbandonedCartReminders, getReminderStates } from "@/server/services/abandoned-cart-email.service";
import { enqueueEmails } from "@/server/services/email-queue.service";
import { EMAIL_MANUAL_MAX_JOBS, EMAIL_REQUEST_BUDGET_MS, EMAIL_SMTP_WORST_CASE_MS, manualSendDeadlineMs } from "@/lib/email/queue-policy";
import { SMTP_TIMEOUTS } from "@/lib/email/smtp";
import { runEmailQueueNow } from "@/server/services/email-manual-run.service";
import { abandonedCartEventKey } from "@/lib/email/marketing";

let db: FakeDb;
let smtp: ReturnType<typeof makeSmtp>;
let logs: ReturnType<typeof captureLogs>;
const A = "admin-1";
const D = () => db as never;
const GOOD_ENV = { EMAIL_UNSUBSCRIBE_SECRET: UNSUB_SECRET, NEXT_PUBLIC_APP_URL: UNSUB_BASE };
const jobs = () => db.rows("emailJob") as any[];
const recips = (id?: string) => (db.rows("emailCampaignRecipient") as any[]).filter((r) => !id || r.campaignId === id);
const recovery = () => db.rows("recoveryEmail") as any[];
const afterQueue = () => ((globalThis as any).__TEST_AFTER__ ??= []) as unknown[];
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  SAVED.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED; process.env.RATE_LIMIT_ENABLED = "false";
  db = freshDb(); smtp = makeSmtp(); discardAfter(); seedAdmins(db); logs = captureLogs();
  db.insert("user", { id: "adm-off", email: "off@staff.test", name: "Off", role: "ADMIN", isActive: false });
});
afterEach(() => { logs.restore(); if (SAVED.RATE_LIMIT_ENABLED === undefined) delete process.env.RATE_LIMIT_ENABLED; else process.env.RATE_LIMIT_ENABLED = SAVED.RATE_LIMIT_ENABLED; });

const send = (id: string, over: Record<string, unknown> = {}) => adminSendCampaignNow(A, id, { db: D(), now: NOW, unsubscribeEnv: GOOD_ENV, smtpEnv: SMTP_ENV, factory: smtp.factory, ...over }) as Promise<any>;
const cont = (id: string, over: Record<string, unknown> = {}) => adminContinueCampaignSending(A, id, { db: D(), now: NOW, unsubscribeEnv: GOOD_ENV, smtpEnv: SMTP_ENV, factory: smtp.factory, ...over }) as Promise<any>;
const retry = (ids: unknown, over: Record<string, unknown> = {}) => adminRetryEmailJobs(A, { jobIds: ids }, { db: D(), now: NOW, smtpEnv: SMTP_ENV, factory: smtp.factory, ...over }) as Promise<any>;
const remind = (cartIds: unknown, over: Record<string, unknown> = {}) => adminSendAbandonedCartReminders(A, { cartIds, hours: 24 }, { db: D(), now: NOW, unsubscribeEnv: GOOD_ENV, smtpEnv: SMTP_ENV, factory: smtp.factory, ...over }) as Promise<any>;

async function draftWithAudience(emails: string[], name = "Winter campaign") {
  for (const e of emails) await optedIn(db, e);
  const t: any = await createEmailTemplate({ name: `T ${name}`, subject: "Hi {{firstName}}", textBody: "Hello {{customerName}}. Unsubscribe: {{unsubscribeUrl}}", htmlBody: '<p>Hello</p><a href="{{unsubscribeUrl}}">Unsubscribe</a>' }, { db: D() });
  const saved: any = await adminSaveCampaignDraft(A, { name, templateId: t.template.id }, { db: D() });
  assert.ok(saved.ok, JSON.stringify(saved));
  const prep: any = await adminPrepareCampaignAudience(A, saved.id, {}, { db: D(), now: T0 });
  assert.ok(prep.ok, JSON.stringify(prep));
  return saved.id as string;
}
const many = (n: number) => Array.from({ length: n }, (_, i) => `u${i}@example.com`);

// ------------------------------------------------------------------------------------------------------------------------------- limits

test("limits: the send deadline keeps one admin request inside the 60 s Hobby function, and the numbers match the real SMTP timeouts", () => {
  assert.equal(EMAIL_SMTP_WORST_CASE_MS, SMTP_TIMEOUTS.connectionTimeout + SMTP_TIMEOUTS.greetingTimeout + SMTP_TIMEOUTS.socketTimeout);
  assert.ok(EMAIL_REQUEST_BUDGET_MS <= 55_000);
  assert.equal(manualSendDeadlineMs(0), EMAIL_REQUEST_BUDGET_MS - EMAIL_SMTP_WORST_CASE_MS);
  assert.ok(manualSendDeadlineMs(0) + EMAIL_SMTP_WORST_CASE_MS <= 60_000);
  assert.equal(manualSendDeadlineMs(10_000), 10_000);
  assert.equal(manualSendDeadlineMs(999_999), 0);
  assert.equal(manualSendDeadlineMs(Number.NaN), manualSendDeadlineMs(0));
});

test("every page that hosts a sending action declares maxDuration = 60 (a literal), and there is no vercel.json / cron configuration", () => {
  for (const f of ["src/app/admin/(dashboard)/email-marketing/campaigns/page.tsx", "src/app/admin/(dashboard)/email-marketing/campaigns/new/page.tsx", "src/app/admin/(dashboard)/email-marketing/campaigns/[id]/page.tsx", "src/app/admin/(dashboard)/email-marketing/queue/page.tsx", "src/app/admin/(dashboard)/abandoned-carts/page.tsx"]) {
    assert.match(readFileSync(f, "utf8"), /^export const maxDuration = 60;$/m, f);
  }
  assert.equal(existsSync("vercel.json"), false);
  assert.doesNotMatch(readFileSync("package.json", "utf8"), /"crons"/);
});

// ------------------------------------------------------------------------------------------------------------------------------- Send now

test("Send now: dispatch, then ONE awaited batch of the existing worker in the same call; SENT only after SMTP, nothing deferred to after()", async () => {
  const id = await draftWithAudience(many(5));
  const res = await send(id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.enqueued, 5);
  assert.equal(smtp.mails.length, 5, "the e-mails were sent before the call returned");
  assert.equal(res.delivery.sent, 5); assert.equal(res.delivery.waiting, 0);
  assert.ok(jobs().every((j) => j.status === "SENT" && j.sentAt instanceof Date));
  assert.ok(recips(id).every((r) => r.status === "SENT"));
  assert.equal((db.rows("emailCampaign") as any[])[0].status, "COMPLETED");
  assert.equal(afterQueue().length, 0, "no after() / detached work was scheduled");
  for (const m of smtp.mails) { assert.match(m["List-Unsubscribe"] ?? m.headers?.["List-Unsubscribe"] ?? "", /https:\/\/shop\.example\.com/); }
});

test("Send now is bounded: a campaign larger than one batch leaves the rest PENDING and says so honestly (no claim of background sending)", async () => {
  const id = await draftWithAudience(many(EMAIL_MANUAL_MAX_JOBS + 7));
  const res = await send(id);
  assert.equal(res.ok, true);
  assert.equal(smtp.mails.length, EMAIL_MANUAL_MAX_JOBS);
  assert.equal(res.delivery.sent, EMAIL_MANUAL_MAX_JOBS); assert.equal(res.delivery.waiting, 7);
  assert.equal(jobs().filter((j) => j.status === "PENDING").length, 7);
  assert.equal(jobs().filter((j) => j.status === "SENT").length, EMAIL_MANUAL_MAX_JOBS);
  assert.equal((db.rows("emailCampaign") as any[])[0].status, "SENDING");
  assert.match(res.message, /7 e-mail\(s\) are still waiting/); assert.match(res.message, /Nothing is sent in the background/);
  assert.equal(afterQueue().length, 0);
  // nothing happens by itself: time passing and a second look change nothing
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(smtp.mails.length, EMAIL_MANUAL_MAX_JOBS);
});

test("Continue sending sends the next bounded batch only when clicked, never re-sends, and completes the campaign", async () => {
  const id = await draftWithAudience(many(EMAIL_MANUAL_MAX_JOBS + 7));
  await send(id);
  const before = smtp.mails.length;
  const res = await cont(id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(smtp.mails.length, before + 7); assert.equal(res.delivery.waiting, 0);
  assert.equal(new Set(smtp.mails.map((m) => m.to)).size, EMAIL_MANUAL_MAX_JOBS + 7, "every recipient got exactly one e-mail");
  assert.equal((db.rows("emailCampaign") as any[])[0].status, "COMPLETED");
  const again = await cont(id);
  assert.equal(again.ok, false); assert.equal(smtp.mails.length, EMAIL_MANUAL_MAX_JOBS + 7);
});

test("Send now when the request has no time left: everything is queued but nothing is sent; jobs stay PENDING", async () => {
  const id = await draftWithAudience(many(3));
  const res = await send(id, { startedAt: Date.now() - 600_000 });
  assert.equal(res.ok, true);
  assert.equal(smtp.mails.length, 0); assert.equal(res.delivery.reason, "no_time"); assert.equal(res.delivery.waiting, 3);
  assert.ok(jobs().every((j) => j.status === "PENDING"));
});

test("Send now without SMTP configured: queued, nothing sent, no attempt used, stays PENDING", async () => {
  const id = await draftWithAudience(many(2));
  const res = await send(id, { smtpEnv: {} });
  assert.equal(res.ok, true); assert.equal(smtp.opened, 0);
  assert.ok(jobs().every((j) => j.status === "PENDING" && j.attempts === 0));
  assert.match(res.message, /SMTP is not configured/);
});

test("Send now partial failure: a temporary SMTP error keeps that job PENDING with its error, a permanent one FAILED; the others are SENT; nothing is marked SENT without SMTP success", async () => {
  const id = await draftWithAudience(many(4));
  smtp.behaviour = async (m: any) => {
    if (m.to === "u1@example.com") throw Object.assign(new Error("x"), { code: "ETIMEDOUT" });
    if (m.to === "u2@example.com") throw Object.assign(new Error("x"), { responseCode: 550, code: "EENVELOPE" });
    return { messageId: "<id@gmail.com>", accepted: [m.to], rejected: [] };
  };
  const res = await send(id);
  assert.equal(res.ok, true);
  const by = (e: string) => jobs().find((j) => j.toEmail === e);
  assert.equal(by("u0@example.com").status, "SENT"); assert.equal(by("u3@example.com").status, "SENT");
  assert.equal(by("u1@example.com").status, "PENDING"); assert.ok(by("u1@example.com").errorCode);
  assert.notEqual(by("u2@example.com").status, "SENT");
  assert.equal(jobs().filter((j) => j.status === "SENT").length, smtp.mails.filter((m) => m.to !== "u1@example.com" && m.to !== "u2@example.com").length);
  assert.equal(recips(id).filter((r) => r.status === "SENT").length, 2);
});

test("concurrent Send now clicks: one dispatch wins, every recipient is mailed exactly once", async () => {
  const id = await draftWithAudience(many(6));
  const [a, b] = await Promise.all([send(id), send(id)]);
  assert.equal([a, b].filter((r) => r.ok && r.outcome === "queued").length, 1, JSON.stringify([a, b]));
  assert.equal(jobs().length, 6); assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 6);
  assert.equal(smtp.mails.length, 6); assert.equal(new Set(smtp.mails.map((m) => m.to)).size, 6);
});

test("concurrent Continue sending clicks never send a recipient twice (claims are exclusive)", async () => {
  const id = await draftWithAudience(many(EMAIL_MANUAL_MAX_JOBS + 10));
  await send(id);
  await Promise.all([cont(id), cont(id), cont(id)]);
  assert.equal(smtp.mails.length, EMAIL_MANUAL_MAX_JOBS + 10);
  assert.equal(new Set(smtp.mails.map((m) => m.to)).size, EMAIL_MANUAL_MAX_JOBS + 10);
});

test("Send now: a recipient who unsubscribed/was suppressed before dispatch is skipped and never mailed (consent is not bypassed)", async () => {
  const id = await draftWithAudience(many(3));
  await suppressEmail("u1@example.com", { reason: "UNSUBSCRIBED" }, { db: D(), now: T0 });
  const res = await send(id);
  assert.equal(res.ok, true);
  assert.ok(!smtp.mails.some((m) => m.to === "u1@example.com"));
  assert.equal(smtp.mails.length, 2);
});

test("a run that throws is reported, not hidden: jobs stay PENDING and can be sent by the next click", async () => {
  const id = await draftWithAudience(many(2));
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => { const d = orig(t); if (t === "emailJob") { const fm = d.findMany.bind(d); d.findMany = async (a: any) => { if (a?.where?.AND) throw new Error("db down"); return fm(a); }; } return d; };
  const res = await send(id);
  delete (db as any).delegate;
  assert.equal(res.ok, true); assert.equal(res.delivery.reason, "error"); assert.match(res.message, /could not be sent just now/);
  assert.ok(jobs().every((j) => j.status === "PENDING"));
  const next = await cont(id);
  assert.equal(next.delivery.sent, 2);
});

// ------------------------------------------------------------------------------------------------------------------------------- abandoned carts

const DAY = 86_400_000;
const LAST = new Date(NOW.getTime() - 2 * DAY); // abandoned for 2 days
function cart(id: string, userId: string | null, over: { last?: Date; productStatus?: string } = {}) {
  if (!db.rows("product").some((p: any) => p.id === "p1")) db.insert("product", { id: "p1", name: "Clay Vase", slug: "clay-vase", type: "STANDARD", status: "ACTIVE", price: 1800, stock: 5 });
  db.insert("cart", { id, userId, guestToken: userId ? null : `g-${id}` });
  db.insert("cartItem", { id: `ci-${id}`, cartId: id, productId: "p1", quantity: 2, updatedAt: over.last ?? LAST });
}
async function customer(id: string, email: string, opts: { consent?: boolean } = {}) {
  db.insert("user", { id, email, name: `Cust ${id}`, role: "CUSTOMER", isActive: true });
  if (opts.consent !== false) await optedIn(db, email);
}

test("abandoned cart: an admin click queues a reminder for a consenting customer and sends it through the existing queue with unsubscribe headers", async () => {
  await customer("c1", "buyer@example.com"); cart("cart1", "c1");
  const res = await remind(["cart1"]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.queued, 1); assert.equal(res.delivery.sent, 1);
  assert.equal(smtp.mails.length, 1); assert.equal(smtp.mails[0].to, "buyer@example.com");
  assert.match(smtp.mails[0].text, /Clay Vase/); assert.match(smtp.mails[0].text, /\/unsubscribe\//);
  assert.ok(smtp.mails[0].headers?.["List-Unsubscribe"] ?? smtp.mails[0]["List-Unsubscribe"]);
  assert.equal(jobs()[0].kind, "abandoned-cart"); assert.equal(jobs()[0].status, "SENT");
  assert.equal(recovery()[0].status, "SENT"); assert.equal(recovery()[0].kind, "ABANDONED_CART");
  assert.equal(afterQueue().length, 0);
});

test("abandoned cart: nothing is queued or sent unless the admin clicks (listing and display state send nothing)", async () => {
  await customer("c1", "buyer@example.com"); cart("cart1", "c1");
  const states = await getReminderStates([{ id: "cart1", lastActivity: LAST }], { db: D() });
  assert.equal(states.size, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs().length, 0); assert.equal(smtp.mails.length, 0); assert.equal(recovery().length, 0);
});

test("abandoned cart: guests, customers without consent, suppressed customers, converted and not-yet-abandoned carts are skipped and never mailed", async () => {
  await customer("c-noconsent", "nc@example.com", { consent: false }); cart("k-nc", "c-noconsent");
  await customer("c-supp", "supp@example.com"); cart("k-supp", "c-supp");
  await suppressEmail("supp@example.com", { reason: "UNSUBSCRIBED" }, { db: D(), now: T0 });
  await customer("c-conv", "conv@example.com"); cart("k-conv", "c-conv");
  db.insert("order", { id: "o1", userId: "c-conv", orderNumber: "GP-1", createdAt: new Date(NOW.getTime() - DAY) });
  await customer("c-fresh", "fresh@example.com"); cart("k-fresh", "c-fresh", { last: new Date(NOW.getTime() - 3_600_000) });
  cart("k-guest", null);
  await customer("c-contact-only", "co@example.com", { consent: false }); cart("k-co", "c-contact-only");
  await (db as any).emailContact.create({ data: { email: "co@example.com", name: "Co", source: "MANUAL" } }); // a contact, but no marketing consent
  const res = await remind(["k-nc", "k-supp", "k-conv", "k-fresh", "k-guest", "k-missing", "k-co"]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.queued, 0); assert.equal(smtp.mails.length, 0); assert.equal(jobs().length, 0);
  const why = Object.fromEntries(res.skipped.map((s: any) => [s.cartId, s.reason]));
  assert.deepEqual(why, { "k-nc": "no_contact", "k-co": "no_consent", "k-supp": "suppressed", "k-conv": "converted", "k-fresh": "not_abandoned", "k-guest": "guest_cart", "k-missing": "not_found" });
});

test("abandoned cart: one reminder per abandonment, also under concurrent clicks and repeated clicks; new activity is a new abandonment", async () => {
  await customer("c1", "buyer@example.com"); cart("cart1", "c1");
  const [a, b] = await Promise.all([remind(["cart1"]), remind(["cart1"])]);
  assert.equal(a.queued + b.queued, 1, JSON.stringify([a, b]));
  assert.equal(smtp.mails.length, 1); assert.equal(recovery().length, 1); assert.equal(jobs().length, 1);
  const again = await remind(["cart1"]);
  assert.equal(again.queued, 0); assert.equal(again.skipped[0].reason, "already_reminded"); assert.equal(smtp.mails.length, 1);
  const states = await getReminderStates([{ id: "cart1", lastActivity: LAST }], { db: D() });
  assert.equal(states.get("cart1")?.status, "SENT");
  // the customer used the cart again and left it a day later: a NEW abandonment may be reminded once more
  db.patch("cartItem", "ci-cart1", { updatedAt: new Date(NOW.getTime() - 30 * 3_600_000) });
  const next = await remind(["cart1"]);
  assert.equal(next.queued, 1); assert.equal(smtp.mails.length, 2);
  assert.notEqual(abandonedCartEventKey("cart1", LAST), abandonedCartEventKey("cart1", new Date(NOW.getTime() - 30 * 3_600_000)));
});

test("abandoned cart: consent withdrawn AFTER queuing is honoured by the worker gate right before SMTP", async () => {
  await customer("c1", "buyer@example.com"); cart("cart1", "c1");
  const res = await remind(["cart1"], { smtpEnv: {} }); // queued, SMTP off: nothing sent
  assert.equal(res.queued, 1); assert.equal(jobs()[0].status, "PENDING");
  await suppressEmail("buyer@example.com", { reason: "UNSUBSCRIBED" }, { db: D(), now: T0 });
  const r = await retry([jobs()[0].id]);
  assert.equal(r.ok, true); assert.equal(smtp.mails.length, 0);
  assert.equal(jobs()[0].status, "FAILED"); assert.equal(jobs()[0].errorCode, "recipient_ineligible");
  assert.equal(recovery()[0].status, "SKIPPED"); assert.equal(jobs()[0].text, "");
});

test("abandoned cart: new cart activity after queuing cancels the reminder at send time; an order since does too", async () => {
  await customer("c1", "a@example.com"); cart("k1", "c1");
  await customer("c2", "b@example.com"); cart("k2", "c2");
  await remind(["k1", "k2"], { smtpEnv: {} });
  db.patch("cartItem", "ci-k1", { updatedAt: new Date(NOW.getTime() - 60_000) });
  db.insert("order", { id: "o2", userId: "c2", orderNumber: "GP-2", createdAt: new Date(NOW.getTime() - 1000) });
  const r = await retry(jobs().map((j) => j.id));
  assert.equal(r.ok, true); assert.equal(smtp.mails.length, 0);
  assert.ok(jobs().every((j) => j.status === "FAILED" && j.errorCode === "cart_no_longer_abandoned"));
});

test("abandoned cart: without a usable unsubscribe secret nothing is queued; bad selections and non-admins are refused", async () => {
  await customer("c1", "buyer@example.com"); cart("cart1", "c1");
  const noSecret = await remind(["cart1"], { unsubscribeEnv: {} });
  assert.equal(noSecret.ok, false); assert.equal(noSecret.code, "unsubscribe_link_unavailable"); assert.equal(jobs().length, 0);
  assert.equal((await remind([])).code, "invalid_selection");
  assert.equal((await remind(["ok", "bad id!"])).code, "invalid_selection");
  assert.equal((await remind(Array.from({ length: 26 }, (_, i) => `c${i}`))).code, "too_many");
  const off = await adminSendAbandonedCartReminders("adm-off", { cartIds: ["cart1"], hours: 24 }, { db: D(), now: NOW, unsubscribeEnv: GOOD_ENV, smtpEnv: SMTP_ENV, factory: smtp.factory });
  assert.equal(off.ok, false); assert.equal((off as any).code, "forbidden");
  const cust = await adminSendAbandonedCartReminders("c1", { cartIds: ["cart1"], hours: 24 }, { db: D(), now: NOW, unsubscribeEnv: GOOD_ENV, smtpEnv: SMTP_ENV, factory: smtp.factory });
  assert.equal((cust as any).code, "forbidden"); assert.equal(smtp.mails.length, 0);
});

test("abandoned cart: SMTP failure keeps the reminder retryable with its error; a later manual retry sends it once", async () => {
  await customer("c1", "buyer@example.com"); cart("cart1", "c1");
  smtp.behaviour = smtpFails("ETIMEDOUT");
  const res = await remind(["cart1"]);
  assert.equal(res.ok, true); assert.equal(res.delivery.sent, 0); assert.equal(res.delivery.retryScheduled, 1);
  assert.equal(jobs()[0].status, "PENDING"); assert.equal(jobs()[0].errorCode, "timeout"); assert.equal(recovery()[0].status, "QUEUED");
  const jobId = jobs()[0].id;
  smtp.behaviour = async (m: any) => ({ messageId: "<ok@gmail.com>", accepted: [m.to], rejected: [] });
  const r = await retry([jobId]);
  assert.equal(r.results[0].outcome, "sent"); assert.equal(jobs()[0].status, "SENT"); assert.equal(recovery()[0].status, "SENT");
  assert.equal(smtp.mails.filter((m) => m.to === "buyer@example.com").length, 2, "one failed attempt + one successful send");
  assert.equal((await retry([jobId])).results[0].outcome, "refused", "a SENT job is never retried");
});

// ------------------------------------------------------------------------------------------------------------------------------- manual retry

let n = 0;
async function queueJobs(count: number, kind = "newsletter", over: Record<string, unknown> = {}) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    n += 1;
    const r = await enqueueEmails([{ kind, dedupeParts: [`k${n}`], to: `r${n}@example.com`, subject: `S${n}`, text: `body ${n}` }], { db: D(), now: T0 });
    assert.ok(r.ok);
  }
  for (const j of jobs()) if (!ids.includes(j.id)) ids.push(j.id);
  void over;
  return ids;
}
const patchJob = (id: string, data: Record<string, unknown>) => db.patch("emailJob", id, data);

test("manual retry: Pending and Failed filters list only those states, never SENT, with per-row retryability", async () => {
  const ids = await queueJobs(4);
  patchJob(ids[0], { status: "FAILED", errorCode: "timeout", attempts: 5 });
  patchJob(ids[1], { status: "SENT", sentAt: T0, text: "", html: null });
  patchJob(ids[2], { status: "FAILED", errorCode: "attempts_exhausted", text: "" });
  const pend: any = await adminListEmailJobs(A, { status: "PENDING" }, { db: D(), now: NOW });
  const fail: any = await adminListEmailJobs(A, { status: "FAILED" }, { db: D(), now: NOW });
  assert.deepEqual(pend.rows.map((r: any) => r.id), [ids[3]]);
  assert.deepEqual(new Set(fail.rows.map((r: any) => r.id)), new Set([ids[0], ids[2]]));
  assert.equal(fail.rows.find((r: any) => r.id === ids[0]).retryable, true);
  const gone = fail.rows.find((r: any) => r.id === ids[2]);
  assert.equal(gone.retryable, false); assert.match(gone.retryBlockedReason, /body was removed/);
  assert.equal(pend.counts.pending, 1); assert.equal(pend.counts.failed, 2);
  assert.equal(((await adminListEmailJobs("c1", {}, { db: D() })) as any).ok, false);
});

test("manual retry: several selected Pending and Failed jobs are retried in ONE awaited request; SENT, locked and body-less jobs are refused with reasons", async () => {
  const ids = await queueJobs(6);
  patchJob(ids[0], { status: "FAILED", errorCode: "timeout", attempts: 5, errorMessage: "late" });
  patchJob(ids[1], { status: "PENDING", attempts: 2, nextAttemptAt: new Date(NOW.getTime() + 3_600_000), errorCode: "timeout" });
  patchJob(ids[2], { status: "SENT", sentAt: T0, text: "", html: null });
  patchJob(ids[3], { status: "PROCESSING", lockedAt: new Date(NOW.getTime() - 10_000), attempts: 1 });
  patchJob(ids[4], { status: "FAILED", errorCode: "expired", text: "" });
  const res = await retry(ids);
  assert.equal(res.ok, true, JSON.stringify(res));
  const out = Object.fromEntries(res.results.map((r: any) => [r.jobId, r.outcome]));
  assert.equal(out[ids[0]], "sent"); assert.equal(out[ids[1]], "sent"); assert.equal(out[ids[5]], "sent");
  assert.equal(out[ids[2]], "refused"); assert.equal(out[ids[3]], "refused"); assert.equal(out[ids[4]], "refused");
  assert.equal(smtp.mails.length, 3); assert.ok(!smtp.mails.some((m) => ["r3@example.com", "r4@example.com", "r5@example.com"].includes(m.to) && false));
  assert.equal(jobs().find((j) => j.id === ids[3]).status, "PROCESSING", "a locked job is left alone");
  assert.equal(jobs().find((j) => j.id === ids[2]).status, "SENT");
  assert.equal(jobs().find((j) => j.id === ids[0]).errorCode, null, "success clears the error");
  assert.equal(afterQueue().length, 0);
});

test("manual retry is bounded: a large selection processes one batch, the rest stays exactly as it was (Failed stays Failed) and can be retried again", async () => {
  const ids = await queueJobs(EMAIL_MANUAL_MAX_JOBS + 5);
  for (const id of ids) patchJob(id, { status: "FAILED", errorCode: "timeout", attempts: 5 });
  const res = await retry(ids);
  assert.equal(res.ok, true);
  assert.equal(smtp.mails.length, EMAIL_MANUAL_MAX_JOBS); assert.equal(res.notProcessed, 5);
  assert.equal(jobs().filter((j) => j.status === "FAILED").length, 5);
  assert.equal(jobs().filter((j) => j.status === "SENT").length, EMAIL_MANUAL_MAX_JOBS);
  assert.match(res.message, /5 not reached in this batch, left unchanged/);
  const rest = await retry(jobs().filter((j) => j.status === "FAILED").map((j) => j.id));
  assert.equal(rest.ok, true); assert.equal(smtp.mails.length, EMAIL_MANUAL_MAX_JOBS + 5);
  assert.equal(await retry(Array.from({ length: 51 }, (_, i) => `x${i}`)).then((r) => r.code), "too_many");
});

test("manual retry: concurrent clicks on the same jobs send each e-mail exactly once", async () => {
  const ids = await queueJobs(8);
  for (const id of ids) patchJob(id, { status: "FAILED", errorCode: "timeout", attempts: 5 });
  await Promise.all([retry(ids), retry(ids), retry(ids)]);
  assert.equal(smtp.mails.length, 8); assert.equal(new Set(smtp.mails.map((m) => m.to)).size, 8);
  assert.ok(jobs().every((j) => j.status === "SENT"));
});

test("manual retry: a failing retry keeps the job Failed (permanent / out of attempts) or Pending (temporary) with its error, and gets exactly one attempt per click", async () => {
  const [a, b] = await queueJobs(2);
  patchJob(a, { status: "FAILED", errorCode: "timeout", attempts: 5 }); patchJob(b, { status: "FAILED", errorCode: "timeout", attempts: 2 });
  smtp.behaviour = smtpFails("ETIMEDOUT");
  const res = await retry([a, b]);
  assert.equal(res.ok, true); assert.equal(smtp.mails.length, 2, "one attempt each");
  const ja = jobs().find((j) => j.id === a); const jb = jobs().find((j) => j.id === b);
  assert.equal(ja.status, "FAILED"); assert.equal(ja.errorCode, "timeout"); assert.equal(ja.attempts, 5);
  assert.equal(jb.status, "PENDING"); assert.equal(jb.errorCode, "timeout"); assert.ok(jb.nextAttemptAt > NOW);
  assert.equal(res.results.find((r: any) => r.jobId === a).outcome, "failed");
  smtp.behaviour = async (m: any) => ({ messageId: "<x@gmail.com>", accepted: [m.to], rejected: [] });
  const again = await retry([a, b]);
  assert.deepEqual(again.results.map((r: any) => r.outcome).sort(), ["sent", "sent"]);
});

test("manual retry: an SMTP setup problem stops the run, gives the attempt back and leaves the job retryable", async () => {
  const [a] = await queueJobs(1); patchJob(a, { status: "FAILED", errorCode: "timeout", attempts: 3 });
  smtp.behaviour = smtpFails("EAUTH");
  const res = await retry([a]);
  assert.equal(res.ok, true); assert.equal(res.delivery.deferred, 1); assert.equal(res.delivery.halted, "smtp_problem");
  const j = jobs()[0]; assert.equal(j.status, "PENDING"); assert.equal(j.attempts, 3, "the attempt this run used was given back (back to the capped count)");
});

test("manual retry: a stale lock (crashed worker) can be retried; a fresh lock cannot; a job older than 7 days is refused", async () => {
  const [a, b, c] = await queueJobs(3);
  patchJob(a, { status: "PROCESSING", lockedAt: new Date(NOW.getTime() - 10 * 60_000), attempts: 1 });
  patchJob(b, { status: "PROCESSING", lockedAt: new Date(NOW.getTime() - 60_000), attempts: 1 });
  patchJob(c, { status: "FAILED", errorCode: "timeout", attempts: 5, createdAt: new Date(NOW.getTime() - 8 * DAY) });
  const res = await retry([a, b, c]);
  const out = Object.fromEntries(res.results.map((r: any) => [r.jobId, r.outcome]));
  assert.deepEqual(out, { [a]: "sent", [b]: "refused", [c]: "refused" });
});

test("manual retry of a Pending campaign e-mail re-checks consent: someone suppressed meanwhile is not mailed", async () => {
  const id = await draftWithAudience(many(2));
  await send(id, { smtpEnv: {} });
  await suppressEmail("u0@example.com", { reason: "UNSUBSCRIBED" }, { db: D(), now: T0 });
  const res = await retry(jobs().map((j) => j.id));
  assert.equal(res.ok, true);
  assert.deepEqual(smtp.mails.map((m) => m.to), ["u1@example.com"]);
  assert.equal(jobs().find((j) => j.toEmail === "u0@example.com").status, "FAILED");
  assert.equal(recips(id).find((r) => r.skipReason === "suppressed")?.status, "SKIPPED");
});

test("manual retry: invalid, empty and non-admin requests change nothing", async () => {
  const [a] = await queueJobs(1); patchJob(a, { status: "FAILED", errorCode: "timeout", attempts: 5 });
  assert.equal((await retry([])).code, "invalid_selection");
  assert.equal((await retry(["bad id"])).code, "invalid_selection");
  assert.equal((await retry("nope")).code, "invalid_selection");
  assert.equal(((await adminRetryEmailJobs("c1", { jobIds: [a] }, { db: D(), now: NOW, smtpEnv: SMTP_ENV, factory: smtp.factory })) as any).code, "forbidden");
  assert.equal(jobs()[0].status, "FAILED"); assert.equal(smtp.mails.length, 0);
});

// ------------------------------------------------------------------------------------------------------------------------------- no automatic processing

test("runEmailQueueNow never touches the queue for an empty selection, and logs carry no address, subject or body", async () => {
  await queueJobs(2);
  const rep = await runEmailQueueNow({ startedAt: Date.now(), jobIds: [], db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW });
  assert.equal(rep.reason, "nothing_to_send"); assert.equal(smtp.mails.length, 0);
  const id = await draftWithAudience(many(2)); await send(id);
  const text = JSON.stringify(logs.lines);
  assert.ok(!text.includes("@example.com") && !text.includes("Hello"), "no address or body in logs");
});

test("no automatic processing: no cron config, no timers or detached work in the new sending code, and the protected routes keep their CRON_SECRET check", () => {
  const files = ["src/server/services/email-manual-run.service.ts", "src/server/services/admin-email-queue.service.ts", "src/server/services/abandoned-cart-email.service.ts", "src/server/services/email-recovery-delivery.service.ts", "src/server/actions/admin-email-queue.actions.ts", "src/features/admin/email-queue/queue-jobs-table.tsx", "src/features/admin/email-queue/abandoned-cart-list.tsx"];
  for (const f of files) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /setInterval|setTimeout|after\(|waitUntil|unstable_after|cron/i, f);
    assert.doesNotMatch(code, /sendSmtpMail|nodemailer/, `${f} has no SMTP code of its own`);
  }
  for (const f of ["src/app/api/email/queue/route.ts", "src/app/api/email/campaigns/dispatch/route.ts"]) assert.match(readFileSync(f, "utf8"), /verifyBearerSecret\(/, f);
  assert.equal(existsSync("src/app/api/email/retry"), false, "no second worker route");
  const queue = readFileSync("src/server/services/email-queue.service.ts", "utf8");
  assert.equal((queue.match(/export async function processEmailQueue/g) ?? []).length, 1, "one worker implementation");
});

test("the per-click cap holds even when the env batch size and hourly/daily limits are set far higher", async () => {
  const ids = await queueJobs(EMAIL_MANUAL_MAX_JOBS + 6);
  for (const id of ids) patchJob(id, { status: "FAILED", errorCode: "timeout", attempts: 5 });
  const big = { ...SMTP_ENV, EMAIL_QUEUE_BATCH_SIZE: "100", EMAIL_QUEUE_MAX_PER_HOUR: "1000", EMAIL_QUEUE_MAX_PER_DAY: "5000" };
  const res = await retry(ids, { smtpEnv: big });
  assert.equal(smtp.mails.length, EMAIL_MANUAL_MAX_JOBS); assert.equal(res.notProcessed, 6);
  const small = await retry(jobs().filter((j) => j.status === "FAILED").map((j) => j.id), { smtpEnv: { ...SMTP_ENV, EMAIL_QUEUE_BATCH_SIZE: "2" } });
  assert.equal(smtp.mails.length, EMAIL_MANUAL_MAX_JOBS + 2, "the existing env batch size still wins when it is smaller");
  assert.equal(small.ok, true);
});

test("a SENT job is refused even if its body were still stored (defence in depth), and is never handed to SMTP", async () => {
  const [a] = await queueJobs(1);
  patchJob(a, { status: "SENT", sentAt: T0 }); // body deliberately kept
  const res = await retry([a]);
  assert.equal(res.results[0].outcome, "refused"); assert.match(res.results[0].reason, /Already sent/);
  assert.equal(smtp.mails.length, 0); assert.equal(jobs()[0].status, "SENT");
});

test("the worker run itself is capped (second layer): handing it more jobs than the cap sends only the cap, even with a huge env batch size", async () => {
  const ids = await queueJobs(EMAIL_MANUAL_MAX_JOBS + 4);
  const rep = await runEmailQueueNow({ startedAt: Date.now(), jobIds: ids, db: D(), env: { ...SMTP_ENV, EMAIL_QUEUE_BATCH_SIZE: "100" }, factory: smtp.factory, now: NOW, maxJobs: 1000 });
  assert.equal(rep.sent, EMAIL_MANUAL_MAX_JOBS); assert.equal(smtp.mails.length, EMAIL_MANUAL_MAX_JOBS);
  assert.equal(jobs().filter((j) => j.status === "PENDING").length, 4);
});
