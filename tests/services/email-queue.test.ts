/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, drainAfter, freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { deliverEmailJob, enqueueEmail, enqueueEmails, processEmailQueue } from "@/server/services/email-queue.service";
import { EMAIL_JOB_MAX_ATTEMPTS, EMAIL_PROCESSING_STALE_MS, EMAIL_SYSTEMIC_PAUSE_MS } from "@/lib/email/queue-policy";
import { GET, POST } from "@/app/api/email/queue/route";

const PASS = "abcdefghijklmnop";
const env = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "shop@gmail.com", SMTP_PASS: PASS };
const T0 = new Date("2026-11-22T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let db: FakeDb;
let opened: number;
let mails: any[];
let behaviour: (mail: any) => Promise<any>;
const accepts = async (mail: any) => ({ messageId: "<id@gmail.com>", accepted: [mail.to], rejected: [] });
const fails = (code: string) => async () => { throw Object.assign(new Error(`server said no to ${PASS}`), { code }); };
const factory = (): any => { opened++; return { verify: async () => true, sendMail: async (m: any) => { mails.push(m); return behaviour(m); }, close: () => {} }; };
const opts = (over: Record<string, unknown> = {}) => ({ db: db as never, env, factory, now: T0, ...over });

const logged: string[] = [];
const realLog = { warn: console.warn, info: console.info, error: console.error };
const realEnv = { ...process.env };
beforeEach(() => {
  db = freshDb(); opened = 0; mails = []; behaviour = accepts; logged.length = 0; discardAfter();
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  console.info = console.warn; console.error = console.warn;
  process.env.CRON_SECRET = "c".repeat(32);
  for (const k of Object.keys(env)) delete process.env[k];
});
afterEach(() => { Object.assign(console, realLog); process.env = { ...realEnv }; });

const jobs = () => db.rows("emailJob");
// Generic queue-mechanics fixture. Its kind is deliberately NOT "campaign": since the Prompt 11 follow-up a "campaign" job must have a campaign recipient row or it is
// blocked before SMTP (see tests/services/email-campaign-worker.test.ts), and these tests are about the queue itself, not about campaign delivery.
const input = (n: number | string, over: Record<string, unknown> = {}) => ({ kind: "newsletter", dedupeParts: ["c1", `user${n}@example.com`], to: `user${n}@example.com`, subject: `Hello ${n}`, text: `Body for ${n}`, ...over });

// -------------------------------------------------------------------------------------------------------------------------------- states

test("enqueue persists a PENDING job and sends NOTHING during the request", async () => {
  const r = await enqueueEmail(input(1), opts());
  assert.ok(r.ok && r.created);
  assert.equal(opened, 0);
  assert.equal(jobs().length, 1);
  assert.equal(jobs()[0].status, "PENDING");
  assert.equal(jobs()[0].attempts, 0);
});

test("lifecycle: PENDING -> (after-response kick) PROCESSING -> SENT; the body is removed, the audit row stays", async () => {
  await enqueueEmail(input(1, { html: "<p>hi</p>" }), opts());
  assert.equal(mails.length, 0);
  await drainAfter(); // the platform runs the after() callback once the response is out
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, "user1@example.com");
  assert.equal(mails[0].html, "<p>hi</p>");
  const j = jobs()[0];
  assert.equal(j.status, "SENT");
  assert.equal(j.attempts, 1);
  assert.ok(j.sentAt instanceof Date);
  assert.equal(j.text, ""); assert.equal(j.html, null);
  assert.equal(j.lockedAt, null);
  assert.equal(j.messageId, "<id@gmail.com>");
});

test("the kick is only a bonus: if after() never runs, the queue worker sends the job", async () => {
  await enqueueEmail(input(1), opts());
  discardAfter(); // worker died before the kick
  assert.equal(jobs()[0].status, "PENDING");
  const s = await processEmailQueue(opts({ now: at(1000) }));
  assert.equal(s.sent, 1);
  assert.equal(jobs()[0].status, "SENT");
});

test("no kick (and no mail attempt) when SMTP is not configured: the job just waits PENDING with no attempt used", async () => {
  await enqueueEmail(input(1), { db: db as never, env: {}, factory, now: T0 });
  await drainAfter();
  assert.equal(opened, 0);
  assert.deepEqual([jobs()[0].status, jobs()[0].attempts], ["PENDING", 0]);
});

test("a failed enqueue never throws into the caller (e.g. checkout) and logs no address", async () => {
  const broken = { emailJob: { createMany: async () => { throw new Error("db down for buyer@example.com"); } } };
  const r = await enqueueEmail(input(1, { to: "buyer@example.com" }), { db: broken as never, env, factory });
  assert.equal(r.ok, false);
  assert.doesNotMatch(logged.join("\n"), /buyer@example\.com/);
});

// ---------------------------------------------------------------------------------------------------------------------------- duplicates

test("duplicate prevention: the same logical e-mail is one job, however often and however it is spelled", async () => {
  const a = await enqueueEmail(input(1), opts());
  const b = await enqueueEmail(input(1), opts());
  const c = await enqueueEmail(input(1, { dedupeParts: [" C1 ", "USER1@example.com"] }), opts());
  assert.ok(a.ok && b.ok && c.ok);
  if (a.ok && b.ok && c.ok) { assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(c.created, false); assert.equal(b.jobId, a.jobId); assert.equal(c.jobId, a.jobId); }
  assert.equal(jobs().length, 1);
  await drainAfter();
  assert.equal(mails.length, 1, "one e-mail, not three");
});

test("duplicate prevention: a duplicate is not re-sent after the original was SENT", async () => {
  await enqueueEmail(input(1), opts()); await drainAfter();
  const again = await enqueueEmail(input(1), opts()); await drainAfter();
  assert.ok(again.ok && !again.created);
  await processEmailQueue(opts({ now: at(5000) }));
  assert.equal(mails.length, 1);
});

test("duplicate prevention: concurrent enqueues of the same e-mail create one row", async () => {
  const rs = await Promise.all(Array.from({ length: 8 }, () => enqueueEmail(input(1), opts({ kick: false }))));
  assert.equal(rs.filter((r) => r.ok && r.created).length, 1);
  assert.equal(jobs().length, 1);
});

test("different e-mails (other recipient / other campaign / other kind) are separate jobs", async () => {
  for (const over of [input(1), input(2), input(1, { dedupeParts: ["c2", "user1@example.com"] }), input(1, { kind: "reminder" })]) await enqueueEmail(over, opts({ kick: false }));
  assert.equal(jobs().length, 4);
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 4);
  assert.ok(jobs().every((j) => !j.dedupeKey.includes("example.com")));
});

// ----------------------------------------------------------------------------------------------------------------------------- bulk / non-blocking

test("bulk enqueue returns immediately: rows only, no connection, no after() work; bulk priority; invalid and duplicate entries are reported", async () => {
  const list = [...Array.from({ length: 60 }, (_, i) => input(i)), input(3), input("bad", { to: "nope" }), input("bad2", { subject: "x\r\ny" })];
  const r = await enqueueEmails(list, opts());
  assert.deepEqual(r.ok && { queued: r.queued, duplicates: r.duplicates, invalid: r.invalid.map((i) => i.index) }, { queued: 60, duplicates: 1, invalid: [61, 62] });
  assert.equal(opened, 0);
  await drainAfter();
  assert.equal(opened, 0);
  assert.equal(jobs().length, 60);
  assert.ok(jobs().every((j) => j.status === "PENDING" && j.priority === 1));
  const again = await enqueueEmails(list, opts()); // retry after a hypothetical failure: everything is a duplicate now
  assert.deepEqual(again.ok && { q: again.queued, d: again.duplicates }, { q: 0, d: 61 });
  assert.equal(jobs().length, 60);
});

test("bulk enqueue: oversized lists are refused, an empty list is a no-op, concurrent identical lists do not double-queue", async () => {
  const huge = await enqueueEmails(Array.from({ length: 5001 }, (_, i) => input(i)), opts());
  assert.equal(huge.ok, false); assert.equal(jobs().length, 0);
  assert.deepEqual(await enqueueEmails([], opts()), { ok: true, queued: 0, duplicates: 0, invalid: [] });
  const list = Array.from({ length: 30 }, (_, i) => input(i));
  await Promise.all([enqueueEmails(list, opts()), enqueueEmails(list, opts())]);
  assert.equal(jobs().length, 30);
});

// ------------------------------------------------------------------------------------------------------------------------------ rate limiting

test("rate limit: a run sends at most the batch size", async () => {
  await enqueueEmails(Array.from({ length: 10 }, (_, i) => input(i)), opts());
  const s = await processEmailQueue(opts({ env: { ...env, EMAIL_QUEUE_BATCH_SIZE: "3" } }));
  assert.deepEqual([s.budget, s.attempted, s.sent, mails.length], [3, 3, 3, 3]);
  assert.equal(s.queue.pending, 7);
});

test("rate limit: hourly and daily budgets count what was already sent and stop sending at zero", async () => {
  await enqueueEmails(Array.from({ length: 10 }, (_, i) => input(i)), opts());
  const limited = { ...env, EMAIL_QUEUE_BATCH_SIZE: "50", EMAIL_QUEUE_MAX_PER_HOUR: "4", EMAIL_QUEUE_MAX_PER_DAY: "6" };
  assert.equal((await processEmailQueue(opts({ env: limited, now: at(1000) }))).sent, 4); // hour budget
  const none = await processEmailQueue(opts({ env: limited, now: at(60_000) }));
  assert.deepEqual([none.budget, none.sent], [0, 0]); // still inside the same hour
  const nextHour = await processEmailQueue(opts({ env: limited, now: at(61 * 60_000) })); // hour window passed; day budget leaves 2
  assert.deepEqual([nextHour.budget, nextHour.sent], [2, 2]);
  const dayDone = await processEmailQueue(opts({ env: limited, now: at(125 * 60_000) }));
  assert.deepEqual([dayDone.budget, dayDone.sent], [0, 0]);
  const nextDay = await processEmailQueue(opts({ env: limited, now: at(25 * 3_600_000) }));
  assert.equal(nextDay.sent, 4);
  assert.equal(mails.length, 10);
});

test("individual e-mails drain before bulk, even when queued later", async () => {
  await enqueueEmails(Array.from({ length: 5 }, (_, i) => input(i)), opts());
  await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["GP-1"], to: "buyer@example.com", subject: "Order", text: "Thanks" }, opts({ kick: false, now: at(10) }));
  await processEmailQueue(opts({ env: { ...env, EMAIL_QUEUE_BATCH_SIZE: "2" }, now: at(1000) }));
  assert.equal(mails[0].to, "buyer@example.com");
  assert.equal(mails.length, 2);
});

test("a run stops at its time limit without losing anything", async () => {
  await enqueueEmails(Array.from({ length: 5 }, (_, i) => input(i)), opts());
  const s = await processEmailQueue(opts({ deadlineMs: -1 }));
  assert.deepEqual([s.halted, s.attempted], ["time_limit", 0]);
  assert.equal(jobs().filter((j) => j.status === "PENDING").length, 5);
});

// ------------------------------------------------------------------------------------------------------------------------------------ retry

test("temporary failure: PENDING again with a later nextAttemptAt; not retried early; retried when due; a fixed message only", async () => {
  await enqueueEmail(input(1), opts({ kick: false }));
  behaviour = fails("ETIMEDOUT");
  assert.equal(await deliverEmailJob(jobs()[0].id, opts()), "retry_scheduled");
  let j = jobs()[0];
  assert.deepEqual([j.status, j.attempts, j.errorCode, j.lockedAt], ["PENDING", 1, "timeout", null]);
  assert.equal(j.nextAttemptAt.getTime() - T0.getTime(), 60_000);
  assert.ok(!j.errorMessage.includes(PASS));
  assert.equal(await deliverEmailJob(j.id, opts({ now: at(30_000) })), "not_claimed"); // not due yet
  assert.equal((await processEmailQueue(opts({ now: at(30_000) }))).attempted, 0);
  behaviour = accepts;
  assert.equal((await processEmailQueue(opts({ now: at(61_000) }))).sent, 1);
  j = jobs()[0];
  assert.deepEqual([j.status, j.attempts, j.errorCode], ["SENT", 2, null]);
});

test("temporary failures give up after the maximum attempts: FAILED, never retried again", async () => {
  await enqueueEmail(input(1), opts({ kick: false }));
  behaviour = fails("ECONNREFUSED");
  let now = T0.getTime();
  for (let n = 1; n <= EMAIL_JOB_MAX_ATTEMPTS; n++) {
    const outcome = await deliverEmailJob(jobs()[0].id, opts({ now: new Date(now) }));
    assert.equal(outcome, n < EMAIL_JOB_MAX_ATTEMPTS ? "retry_scheduled" : "failed", `attempt ${n}`);
    now = jobs()[0].nextAttemptAt.getTime() + 1;
  }
  const j = jobs()[0];
  assert.deepEqual([j.status, j.attempts, j.errorCode], ["FAILED", EMAIL_JOB_MAX_ATTEMPTS, "connection_failed"]);
  const before = opened;
  await processEmailQueue(opts({ now: new Date(now + 86_400_000) }));
  assert.equal(opened, before, "a FAILED job is not sent again");
});

test("permanent failure (recipient refused): FAILED at once, one attempt only", async () => {
  await enqueueEmail(input(1), opts({ kick: false }));
  behaviour = fails("EENVELOPE");
  assert.equal(await deliverEmailJob(jobs()[0].id, opts()), "failed");
  assert.deepEqual([jobs()[0].status, jobs()[0].attempts, jobs()[0].errorCode], ["FAILED", 1, "recipient_rejected"]);
  assert.equal((await processEmailQueue(opts({ now: at(86_400_000) }))).attempted, 0);
});

test("a server that accepts nobody counts as a refused recipient (no silent success)", async () => {
  await enqueueEmail(input(1), opts({ kick: false }));
  behaviour = async (m) => ({ messageId: "x", accepted: [], rejected: [m.to] });
  assert.equal(await deliverEmailJob(jobs()[0].id, opts()), "failed");
  assert.equal(jobs()[0].status, "FAILED");
});

test("broken SMTP login pauses the whole queue: one attempt, no attempt used up, run halts, job waits", async () => {
  await enqueueEmails(Array.from({ length: 5 }, (_, i) => input(i)), opts());
  behaviour = fails("EAUTH");
  const s = await processEmailQueue(opts());
  assert.deepEqual([s.halted, s.attempted, s.deferred, opened], ["smtp_problem", 1, 1, 1]); // 4 other jobs never touched the server
  const paused = jobs().find((j) => j.errorCode === "auth_failed")!;
  assert.deepEqual([paused.status, paused.attempts], ["PENDING", 0]);
  assert.equal(paused.nextAttemptAt.getTime() - T0.getTime(), EMAIL_SYSTEMIC_PAUSE_MS);
  // Fixed later: everything is delivered, nothing was lost or failed.
  behaviour = accepts;
  const fixed = await processEmailQueue(opts({ now: at(EMAIL_SYSTEMIC_PAUSE_MS + 1000) }));
  assert.equal(fixed.sent, 5);
  assert.ok(jobs().every((j) => j.status === "SENT"));
});

test("SMTP not configured: the run touches no job and uses no attempt", async () => {
  await enqueueEmails(Array.from({ length: 3 }, (_, i) => input(i)), opts());
  const s = await processEmailQueue(opts({ env: {} }));
  assert.deepEqual([s.smtpReady, s.attempted, s.queue.pending, opened], [false, 0, 3, 0]);
  assert.ok(jobs().every((j) => j.attempts === 0));
});

// ------------------------------------------------------------------------------------------------------------------------ claims & crash recovery

test("a job is claimed by exactly one worker: parallel deliveries send ONE e-mail", async () => {
  await enqueueEmail(input(1), opts({ kick: false }));
  const id = jobs()[0].id;
  const outcomes = await Promise.all([deliverEmailJob(id, opts()), deliverEmailJob(id, opts()), deliverEmailJob(id, opts())]);
  assert.deepEqual([...outcomes].sort(), ["not_claimed", "not_claimed", "sent"]);
  assert.equal(mails.length, 1);
});

test("overlapping queue runs never double-send", async () => {
  await enqueueEmails(Array.from({ length: 12 }, (_, i) => input(i)), opts());
  await Promise.all([processEmailQueue(opts()), processEmailQueue(opts()), processEmailQueue(opts())]);
  const sentTo = mails.map((m) => m.to);
  assert.equal(new Set(sentTo).size, sentTo.length, "no recipient got it twice");
  assert.equal(sentTo.length, 12);
});

test("crashed worker: a PROCESSING claim is left alone while fresh and re-claimed once stale", async () => {
  await enqueueEmail(input(1), opts({ kick: false }));
  const id = jobs()[0].id;
  db.patch("emailJob", id, { status: "PROCESSING", attempts: 1, lockedAt: T0 });
  assert.equal(await deliverEmailJob(id, opts({ now: at(EMAIL_PROCESSING_STALE_MS - 1000) })), "not_claimed");
  assert.equal(await deliverEmailJob(id, opts({ now: at(EMAIL_PROCESSING_STALE_MS + 1000) })), "sent");
  assert.deepEqual([jobs()[0].status, jobs()[0].attempts], ["SENT", 2]);
});

test("a stale claim that already used every attempt is FAILED, not sent again", async () => {
  await enqueueEmail(input(1), opts({ kick: false }));
  const id = jobs()[0].id;
  db.patch("emailJob", id, { status: "PROCESSING", attempts: EMAIL_JOB_MAX_ATTEMPTS, lockedAt: T0 });
  const s = await processEmailQueue(opts({ now: at(EMAIL_PROCESSING_STALE_MS + 1000) }));
  assert.deepEqual([s.housekeeping.exhausted, s.attempted, opened], [1, 0, 0]);
  assert.deepEqual([jobs()[0].status, jobs()[0].errorCode], ["FAILED", "attempts_exhausted"]);
});

test("an internal error mid-delivery leaves a recoverable claim and logs only the error class, never the address or text", async () => {
  await enqueueEmail(input(1, { to: "secret.person@example.com", text: "private body text" }), opts({ kick: false }));
  const id = jobs()[0].id;
  const real = (db as any).emailJob;
  const flaky = { emailJob: { updateMany: real.updateMany, findUnique: async () => { throw new Error("connection to secret.person@example.com lost: private body text"); } } };
  assert.equal(await deliverEmailJob(id, { db: flaky as never, env, factory, now: T0 }), "retry_scheduled");
  assert.equal(opened, 0);
  assert.equal(jobs()[0].status, "PROCESSING"); // the stale-claim rule recovers it
  assert.doesNotMatch(logged.join("\n"), /secret\.person|private body|connection to/);
  assert.equal(await deliverEmailJob(id, opts({ now: at(EMAIL_PROCESSING_STALE_MS + 1000) })), "sent");
});

// ------------------------------------------------------------------------------------------------------------------------------ housekeeping

test("housekeeping: week-old PENDING jobs expire unsent with the body removed; old SENT/FAILED rows are purged; recent ones kept", async () => {
  const mk = (id: string, over: Record<string, unknown>) => db.insert("emailJob", { id, kind: "campaign", dedupeKey: `k:${id}`, priority: 1, toEmail: "a@example.com", subject: "s", text: "body", nextAttemptAt: T0, createdAt: T0, ...over });
  const day = 86_400_000;
  mk("old-pending", { createdAt: new Date(T0.getTime() - 8 * day), nextAttemptAt: new Date(T0.getTime() - 8 * day) });
  mk("fresh-pending", { createdAt: new Date(T0.getTime() - 1 * day), nextAttemptAt: new Date(T0.getTime() + 99 * day) });
  mk("old-sent", { status: "SENT", sentAt: new Date(T0.getTime() - 31 * day), text: "" });
  mk("new-sent", { status: "SENT", sentAt: new Date(T0.getTime() - 2 * day), text: "" });
  mk("old-failed", { status: "FAILED", createdAt: new Date(T0.getTime() - 61 * day) });
  mk("new-failed", { status: "FAILED", createdAt: new Date(T0.getTime() - 10 * day), text: "keep for review" });
  const s = await processEmailQueue(opts());
  assert.deepEqual(s.housekeeping, { expired: 1, exhausted: 0, purged: 2 });
  const byId = Object.fromEntries(jobs().map((j) => [j.id, j]));
  assert.deepEqual(Object.keys(byId).sort(), ["fresh-pending", "new-failed", "new-sent", "old-pending"]);
  assert.deepEqual([byId["old-pending"].status, byId["old-pending"].errorCode, byId["old-pending"].text], ["FAILED", "expired", ""]);
  assert.equal(byId["new-failed"].text, "keep for review");
  assert.equal(opened, 0);
});

// ------------------------------------------------------------------------------------------------------------------------------- safe logging

test("logs and stored errors never contain addresses, subjects, bodies or the SMTP password", async () => {
  await enqueueEmails([input(1, { to: "visible.person@example.com", dedupeParts: ["c", "visible.person@example.com"], subject: "Private subject line", text: "Private body" })], opts());
  for (const code of ["EAUTH", "ETIMEDOUT", "EENVELOPE", "ECONNREFUSED"]) {
    behaviour = fails(code);
    db.patch("emailJob", jobs()[0].id, { status: "PENDING", attempts: 0, nextAttemptAt: T0 });
    await processEmailQueue(opts());
  }
  behaviour = accepts;
  db.patch("emailJob", jobs()[0].id, { status: "PENDING", attempts: 0, nextAttemptAt: T0 });
  await processEmailQueue(opts());
  const all = logged.join("\n") + JSON.stringify(jobs().map((j) => [j.errorCode, j.errorMessage, j.dedupeKey, j.messageId]));
  assert.ok(logged.length > 0);
  assert.doesNotMatch(all, /visible\.person|Private subject|Private body|abcdefghijklmnop|shop@gmail/);
});

// ---------------------------------------------------------------------------------------------------------------------------------- the route

test("route: refuses without the bearer secret; with it, runs the queue and returns counts only", async () => {
  await enqueueEmails([input(1, { to: "route.person@example.com", dedupeParts: ["r", "route.person@example.com"] })], opts());
  const url = "http://localhost/api/email/queue";
  assert.equal((await POST(new Request(url, { method: "POST" }))).status, 401);
  assert.equal((await GET(new Request(url, { headers: { authorization: "Bearer wrong" } }))).status, 401);
  delete process.env.CRON_SECRET;
  assert.equal((await POST(new Request(url, { method: "POST", headers: { authorization: "Bearer " } }))).status, 401, "no secret configured = disabled");
  process.env.CRON_SECRET = "c".repeat(32);
  const res = await POST(new Request(url, { method: "POST", headers: { authorization: `Bearer ${"c".repeat(32)}` } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.smtpReady, false); // the test environment has no SMTP settings
  assert.equal(body.queue.pending, 1);
  assert.doesNotMatch(JSON.stringify(body), /route\.person|@/);
});
