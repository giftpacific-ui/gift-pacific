/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prompt 10: the EXISTING queue worker delivering campaign jobs. Everything goes through the real processEmailQueue / deliverEmailJob with a fake SMTP
 * transport: eligibility is re-checked right before SMTP, recipient and campaign status follow the job, and the queue's own retry, rate-limit and
 * stale-lock rules still apply unchanged.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { captureLogs, makeSmtp, NOW, scheduledCampaign, smtpFails, SMTP_ENV, type Fixture } from "../setup/campaign-dispatch-fixture";
import { dispatchEmailCampaign } from "@/server/services/email-campaign-dispatch.service";
import { deliverEmailJob, enqueueEmail, processEmailQueue } from "@/server/services/email-queue.service";
import { gateCampaignJobBeforeSend, reconcileCampaign } from "@/server/services/email-campaign-delivery.service";
import { transitionEmailCampaignStatus } from "@/server/services/email-campaign.service";
import { unsubscribeEmail } from "@/server/services/email-unsubscribe.service";
import { suppressEmail } from "@/server/services/email-suppression.service";
import { withdrawMarketingConsent } from "@/server/services/marketing-consent.service";
import { EMAIL_JOB_MAX_ATTEMPTS, EMAIL_PROCESSING_STALE_MS } from "@/lib/email/queue-policy";

let db: FakeDb;
let smtp: ReturnType<typeof makeSmtp>;
let logs: ReturnType<typeof captureLogs>;
beforeEach(() => { db = freshDb(); smtp = makeSmtp(); discardAfter(); logs = captureLogs(); });
afterEach(() => logs.restore());

const D = () => db as never;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const E = (n: number) => Array.from({ length: n }, (_, i) => `user${i + 1}@example.com`);
const dispatch = (f: Fixture, over: Record<string, unknown> = {}) => dispatchEmailCampaign(f.campaignId, { db: D(), now: NOW, ...over }) as Promise<any>;
const run = (over: Record<string, unknown> = {}) => processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW, ...over });
const jobs = () => db.rows("emailJob");
const campaignRow = (f: Fixture) => db.rows("emailCampaign").find((c) => c.id === f.campaignId)!;
const recipientOf = (f: Fixture, email: string) => f.recipients().find((r) => r.contactId === f.contacts[email].contact.id)!;
const jobOf = (f: Fixture, email: string) => jobs().find((j) => j.id === recipientOf(f, email).emailJobId)!;
async function ready(n: number, over: Record<string, unknown> = {}) { const f = await scheduledCampaign(db, E(n), over); const r = await dispatch(f); assert.ok(r.ok, JSON.stringify(r)); return f; }

// ---------------------------------------------------------------------------------------------------------- eligibility right before SMTP

test("the worker re-checks eligibility immediately before SMTP: unsubscribed after queueing = not sent, job and recipient settled, others still sent", async () => {
  const f = await ready(3);
  await unsubscribeEmail(E(3)[1], "LINK", { db: D(), now: NOW });
  const w = await run();
  assert.deepEqual([w.sent, w.skipped, w.attempted, w.failed], [2, 1, 2, 0], "a skip is not an SMTP attempt");
  assert.deepEqual(smtp.mails.map((m) => m.to).sort(), [E(3)[0], E(3)[2]]);
  const skipped = recipientOf(f, E(3)[1]);
  assert.deepEqual([skipped.status, skipped.skipReason, skipped.sentAt], ["SKIPPED", "suppressed", null]);
  const job = jobOf(f, E(3)[1]);
  assert.deepEqual([job.status, job.errorCode, job.text, job.html], ["FAILED", "recipient_ineligible", "", null], "the body is dropped, the code is fixed");
  const c = campaignRow(f);
  assert.deepEqual([c.status, c.sentCount, c.skippedCount, c.failedCount], ["COMPLETED", 2, 1, 0]);
});

test("every way of becoming ineligible after queueing blocks the send: suppression, bounce, complaint, withdrawn consent, inactive contact, unverifiable", async () => {
  const emails = ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com", "f@example.com", "g@example.com"];
  const f = await scheduledCampaign(db, emails);
  assert.ok((await dispatch(f)).ok);
  await suppressEmail("a@example.com", { reason: "ADMIN" }, { db: D(), now: NOW });
  await suppressEmail("b@example.com", { reason: "BOUNCED" }, { db: D(), now: NOW });
  await suppressEmail("c@example.com", { reason: "COMPLAINED" }, { db: D(), now: NOW });
  await withdrawMarketingConsent(f.contacts["d@example.com"].contact.id, "ADMIN", { db: D(), now: NOW });
  await (db as any).emailContact.update({ where: { id: f.contacts["e@example.com"].contact.id }, data: { isActive: false } });
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailSuppression") { const ff = d.findFirst.bind(d); d.findFirst = async (a: any) => { if (a?.where?.email === "f@example.com") throw new Error("db down"); return ff(a); }; }
    return d;
  };
  const w = await run();
  delete (db as any).delegate;
  assert.deepEqual([w.sent, w.skipped], [1, 6]);
  assert.deepEqual(smtp.mails.map((m) => m.to), ["g@example.com"]);
  const reason = (e: string) => recipientOf(f, e).skipReason;
  assert.deepEqual(["a", "b", "c", "d", "e", "f"].map((x) => reason(`${x}@example.com`)), ["suppressed", "suppressed", "suppressed", "no_consent", "inactive", "unverifiable"]);
});

test("an e-mail whose job address no longer matches the recipient's contact is not sent (fail closed)", async () => {
  const f = await ready(1);
  await (db as any).emailJob.update({ where: { id: jobOf(f, E(1)[0]).id }, data: { toEmail: "someone-else@example.com" } });
  const w = await run();
  assert.deepEqual([w.sent, w.skipped, smtp.mails.length], [0, 1, 0]);
  assert.equal(recipientOf(f, E(1)[0]).skipReason, "unverifiable");
});

test("a campaign cancelled after dispatch stops its queued e-mails: not sent, recipients FAILED(campaign_not_active), counts kept, campaign stays CANCELLED", async () => {
  const f = await ready(3);
  assert.ok((await transitionEmailCampaignStatus(f.campaignId, "CANCELLED", { db: D(), now: NOW })).ok);
  const w = await run();
  assert.deepEqual([w.sent, w.skipped, smtp.mails.length], [0, 3, 0]);
  assert.ok(f.recipients().every((r) => r.status === "FAILED" && r.errorCode === "campaign_not_active"));
  assert.ok(jobs().every((j) => j.status === "FAILED" && j.errorCode === "campaign_not_active"));
  const c = campaignRow(f);
  assert.deepEqual([c.status, c.failedCount, c.sentCount], ["CANCELLED", 3, 0]);
  assert.equal(c.completedAt, null, "a cancelled campaign is never completed");
});

test("a job whose recipient was already settled is not sent again (no duplicate)", async () => {
  const f = await ready(1);
  await (db as any).emailCampaignRecipient.update({ where: { id: recipientOf(f, E(1)[0]).id }, data: { status: "SENT", sentAt: NOW } });
  const w = await run();
  assert.deepEqual([w.sent, w.skipped, smtp.mails.length], [0, 1, 0]);
  assert.equal(jobs()[0].errorCode, "recipient_not_queued");
  assert.equal(recipientOf(f, E(1)[0]).status, "SENT", "the recipient row is left as it was");
});

test("transactional mail is untouched, but a campaign-labelled job with no recipient row is BLOCKED (fail closed): never reaches SMTP", async () => {
  await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["o1"], to: "buyer@example.com", subject: "Order", text: "Thanks" }, { db: D(), now: NOW, kick: false });
  await enqueueEmail({ kind: "campaign", dedupeParts: ["x", "y"], to: "loose@example.com", subject: "Loose", text: "Body" }, { db: D(), now: NOW, kick: false, priority: "bulk" });
  const w = await run();
  assert.deepEqual([w.sent, w.skipped, w.attempted], [1, 1, 1], "only the transactional e-mail is an SMTP attempt; the orphan is skipped");
  assert.deepEqual(smtp.mails.map((m) => m.to), ["buyer@example.com"], "the orphan campaign job never reached SMTP");
  const tx = jobs().find((j) => j.toEmail === "buyer@example.com")!;
  const orphan = jobs().find((j) => j.toEmail === "loose@example.com")!;
  assert.deepEqual([tx.status, tx.errorCode], ["SENT", null]);
  assert.deepEqual([orphan.status, orphan.errorCode, orphan.text, orphan.html], ["FAILED", "recipient_missing", "", null], "settled with a fixed code and the body dropped");
});

test("ORPHAN: a campaign job with no recipient row is blocked even with a body that looks complete, is never retried, and uses no send budget", async () => {
  const contact = (await scheduledCampaign(db, [E(1)[0]])).contacts[E(1)[0]].contact; // a real, opted-in contact (but no campaign recipient row is linked to the job below)
  const queued = await enqueueEmail({ kind: "campaign", dedupeParts: ["ghost", "1"], to: contact.email, subject: "Hi", text: "Hello. Unsubscribe: https://shop.example.com/api/email/unsubscribe/sometoken", html: "<p>Hello <a href=\"https://shop.example.com/api/email/unsubscribe/sometoken\">u</a></p>" }, { db: D(), now: NOW, kick: false, priority: "bulk" });
  assert.ok(queued.ok);
  const w = await run();
  assert.deepEqual([w.sent, w.skipped, w.attempted, w.failed, w.retryScheduled, smtp.mails.length, smtp.opened], [0, 1, 0, 0, 0, 0, 0], "no SMTP connection was even opened");
  const j = jobs()[0];
  assert.deepEqual([j.status, j.errorCode, j.attempts, j.text, j.html, j.lockedAt], ["FAILED", "recipient_missing", 1, "", null, null]);
  const again = await run({ now: at(24 * 3_600_000) });
  assert.deepEqual([again.sent, again.skipped, again.attempted, smtp.mails.length], [0, 0, 0, 0], "a FAILED orphan is final: nothing is retried");
  assert.doesNotMatch(logs.lines.join("\n"), /sometoken|user1@example\.com|Hello/);
});

test("ORPHAN: the gate and the queue agree: gateCampaignJobBeforeSend refuses with recipient_missing and deliverEmailJob reports skipped", async () => {
  await enqueueEmail({ kind: "campaign", dedupeParts: ["ghost", "2"], to: "loose@example.com", subject: "Loose", text: "Body" }, { db: D(), now: NOW, kick: false, priority: "bulk" });
  const job = jobs()[0];
  assert.deepEqual(await gateCampaignJobBeforeSend(job as never, { db: D(), now: NOW }), { send: false, code: "recipient_missing" });
  assert.equal(await deliverEmailJob(job.id, { db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW }), "skipped");
  assert.equal(smtp.mails.length, 0);
  // other kinds are never judged by the campaign gate
  assert.deepEqual(await gateCampaignJobBeforeSend({ id: "t1", kind: "order-confirmation", toEmail: "buyer@example.com", text: "Thanks" }, { db: D(), now: NOW }), { send: true });
});

test("ORPHAN: a campaign recipient whose contact can no longer be resolved is blocked too, and nothing is sent", async () => {
  const f = await ready(2);
  const gone = recipientOf(f, E(2)[0]);
  await (db as any).emailContact.delete({ where: { id: gone.contactId } });
  const w = await run();
  assert.deepEqual([w.sent, w.skipped, smtp.mails.map((m) => m.to)], [1, 1, [E(2)[1]]]);
  assert.equal(recipientOf(f, E(2)[0]).status, "SKIPPED");
  assert.equal(jobOf(f, E(2)[0]).status, "FAILED");
});

test("an orphan campaign job does not disturb valid campaign jobs: they still send with their link and headers, and the campaign completes with its own counts", async () => {
  const f = await ready(2);
  await enqueueEmail({ kind: "campaign", dedupeParts: ["ghost", "3"], to: "loose@example.com", subject: "Loose", text: "Body" }, { db: D(), now: NOW, kick: false, priority: "bulk" });
  const w = await run();
  assert.deepEqual([w.sent, w.skipped], [2, 1]);
  assert.deepEqual(smtp.mails.map((m) => m.to).sort(), E(2), "exactly the two valid recipients were mailed");
  for (const m of smtp.mails) assert.ok(m.headers?.["List-Unsubscribe"] && m.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
  const c = campaignRow(f);
  assert.deepEqual([c.status, c.recipientCount, c.sentCount, c.failedCount, c.skippedCount], ["COMPLETED", 2, 2, 0, 0], "the orphan is in no campaign's counts");
  assert.deepEqual(jobs().find((j) => j.toEmail === "loose@example.com")!.errorCode, "recipient_missing");
});

test("valid campaign retries are unchanged: a temporary SMTP failure keeps the recipient QUEUED and the retry sends the same job once", async () => {
  const f = await ready(1);
  smtp.behaviour = smtpFails("ETIMEDOUT");
  const first = await run();
  assert.deepEqual([first.sent, first.retryScheduled, first.skipped], [0, 1, 0]);
  assert.deepEqual([jobOf(f, E(1)[0]).status, recipientOf(f, E(1)[0]).status], ["PENDING", "QUEUED"]);
  smtp.behaviour = async (m: any) => ({ messageId: "<i@g>", accepted: [m.to], rejected: [] });
  const second = await run({ now: at(3 * 3_600_000) });
  assert.deepEqual([second.sent, second.skipped, jobs().length], [1, 0, 1]);
  assert.deepEqual([jobOf(f, E(1)[0]).status, recipientOf(f, E(1)[0]).status, campaignRow(f).status], ["SENT", "SENT", "COMPLETED"]);
});

// ------------------------------------------------------------------------------------------------------------ delivery and final status

test("successful delivery: recipient SENT with a time, job SENT, counts follow, campaign COMPLETED only when every recipient is settled", async () => {
  const f = await ready(4);
  const w = await run({ env: { ...SMTP_ENV, EMAIL_QUEUE_BATCH_SIZE: "3" } });
  assert.equal(w.sent, 3, "the existing batch limit applies to campaign mail");
  let c = campaignRow(f);
  assert.deepEqual([c.status, c.sentCount, c.completedAt], ["SENDING", 3, null], "one e-mail still queued: not complete");
  assert.equal(f.recipients().filter((r) => r.status === "QUEUED").length, 1);
  await run({ now: at(60_000), env: { ...SMTP_ENV, EMAIL_QUEUE_BATCH_SIZE: "3" } });
  c = campaignRow(f);
  assert.deepEqual([c.status, c.sentCount, c.failedCount, c.skippedCount, c.completedAt?.getTime()], ["COMPLETED", 4, 0, 0, at(60_000).getTime()]);
  assert.ok(f.recipients().every((r) => r.status === "SENT" && r.sentAt instanceof Date && r.errorCode === null));
  assert.ok(jobs().every((j) => j.status === "SENT" && j.text === ""), "bodies are removed once sent");
  assert.equal(smtp.mails.length, 4);
});

test("final failure: a permanently refused address -> job FAILED, recipient FAILED with the fixed code; the others are unaffected", async () => {
  const f = await ready(3);
  smtp.behaviour = async (m: any) => (m.to === E(3)[1] ? smtpFails("EENVELOPE")() : { messageId: "<i@g>", accepted: [m.to], rejected: [] });
  const w = await run();
  assert.deepEqual([w.sent, w.failed], [2, 1]);
  const r = recipientOf(f, E(3)[1]);
  assert.deepEqual([r.status, r.errorCode, r.skipReason], ["FAILED", "recipient_rejected", null]);
  assert.equal(jobOf(f, E(3)[1]).attempts, 1, "a permanent failure is not retried");
  const c = campaignRow(f);
  assert.deepEqual([c.status, c.sentCount, c.failedCount], ["COMPLETED", 2, 1]);
});

test("existing retry policy: a temporary failure keeps the recipient QUEUED and the campaign SENDING; a later success settles it; exhausted retries end FAILED", async () => {
  const f = await ready(2);
  smtp.behaviour = async (m: any) => (m.to === E(2)[0] ? smtpFails("ETIMEDOUT")() : { messageId: "<i@g>", accepted: [m.to], rejected: [] });
  let w = await run();
  assert.deepEqual([w.sent, w.retryScheduled], [1, 1]);
  assert.equal(recipientOf(f, E(2)[0]).status, "QUEUED", "queued is not failed and not sent");
  assert.deepEqual([jobOf(f, E(2)[0]).status, jobOf(f, E(2)[0]).attempts], ["PENDING", 1]);
  assert.equal(campaignRow(f).status, "SENDING");
  // retry becomes due after the backoff and now works
  smtp.behaviour = async (m: any) => ({ messageId: "<i@g>", accepted: [m.to], rejected: [] });
  w = await run({ now: at(2 * 60_000) });
  assert.equal(w.sent, 1);
  assert.equal(recipientOf(f, E(2)[0]).status, "SENT");
  assert.equal(campaignRow(f).status, "COMPLETED");
});

test("retries run out: after the queue's maximum attempts the recipient is FAILED with the last fixed code", async () => {
  const f = await ready(1);
  smtp.behaviour = smtpFails("ECONNREFUSED");
  for (let i = 0; i < EMAIL_JOB_MAX_ATTEMPTS; i++) await run({ now: at((i + 1) * 3 * 3_600_000) });
  const j = jobOf(f, E(1)[0]);
  assert.deepEqual([j.status, j.attempts, j.errorCode], ["FAILED", EMAIL_JOB_MAX_ATTEMPTS, "connection_failed"]);
  const r = recipientOf(f, E(1)[0]);
  assert.deepEqual([r.status, r.errorCode], ["FAILED", "connection_failed"]);
  assert.deepEqual([campaignRow(f).status, campaignRow(f).failedCount], ["COMPLETED", 1]);
});

test("a system-wide SMTP problem pauses the run exactly as before: nothing is marked failed, nothing is lost", async () => {
  const f = await ready(3);
  smtp.behaviour = smtpFails("EAUTH");
  const w = await run();
  assert.deepEqual([w.halted, w.deferred, w.sent], ["smtp_problem", 1, 0]);
  assert.ok(f.recipients().every((r) => r.status === "QUEUED"));
  assert.equal(campaignRow(f).status, "SENDING");
  assert.equal(jobs().filter((j) => j.status === "PENDING").length, 3);
});

test("rate limits apply to campaign mail unchanged: the hourly budget caps a run and the rest waits queued", async () => {
  const f = await ready(5);
  const env = { ...SMTP_ENV, EMAIL_QUEUE_MAX_PER_HOUR: "2", EMAIL_QUEUE_BATCH_SIZE: "100" };
  assert.equal((await run({ env })).sent, 2);
  assert.equal((await run({ env, now: at(60_000) })).sent, 0, "same hour: budget used up");
  assert.deepEqual([f.recipients().filter((r) => r.status === "SENT").length, f.recipients().filter((r) => r.status === "QUEUED").length], [2, 3]);
  assert.equal(campaignRow(f).status, "SENDING");
  assert.equal((await run({ env, now: at(3_700_000) })).sent, 2, "next hour: two more");
});

test("stale-lock recovery still works: a crashed claim on a campaign job is re-claimed, re-checked and sent once", async () => {
  const f = await ready(1);
  const job = jobOf(f, E(1)[0]);
  await (db as any).emailJob.update({ where: { id: job.id }, data: { status: "PROCESSING", attempts: 1, lockedAt: new Date(NOW.getTime() - EMAIL_PROCESSING_STALE_MS - 1000) } });
  const w = await run();
  assert.equal(w.sent, 1);
  assert.equal(smtp.mails.length, 1);
  assert.equal(recipientOf(f, E(1)[0]).status, "SENT");
});

test("stale-lock recovery re-checks eligibility too: a crashed claim of someone who has since unsubscribed is NOT sent", async () => {
  const f = await ready(1);
  await (db as any).emailJob.update({ where: { id: jobOf(f, E(1)[0]).id }, data: { status: "PROCESSING", attempts: 1, lockedAt: new Date(NOW.getTime() - EMAIL_PROCESSING_STALE_MS - 1000) } });
  await unsubscribeEmail(E(1)[0], "LINK", { db: D(), now: NOW });
  const w = await run();
  assert.deepEqual([w.sent, w.skipped, smtp.mails.length], [0, 1, 0]);
  assert.equal(recipientOf(f, E(1)[0]).status, "SKIPPED");
});

test("overlapping workers: a campaign job is claimed once, so the e-mail goes out once", async () => {
  const f = await ready(1);
  const id = jobOf(f, E(1)[0]).id;
  const outcomes = await Promise.all([1, 2, 3].map(() => deliverEmailJob(id, { db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW })));
  assert.deepEqual([...outcomes].sort(), ["not_claimed", "not_claimed", "sent"]);
  assert.equal(smtp.mails.length, 1);
});

// ------------------------------------------------------------------------------------------------------------ reconciliation and counts

test("housekeeping-expired and out-of-attempts jobs are settled onto their recipients by the worker run, and the campaign completes", async () => {
  const f = await ready(2);
  const [a, b] = [jobOf(f, E(2)[0]), jobOf(f, E(2)[1])];
  await (db as any).emailJob.update({ where: { id: a.id }, data: { createdAt: new Date(NOW.getTime() - 8 * 86_400_000) } }); // older than a week
  await (db as any).emailJob.update({ where: { id: b.id }, data: { attempts: EMAIL_JOB_MAX_ATTEMPTS } });
  const w = await run();
  assert.deepEqual([w.housekeeping.expired, w.housekeeping.exhausted, w.sent], [1, 1, 0]);
  assert.deepEqual([recipientOf(f, E(2)[0]).status, recipientOf(f, E(2)[0]).errorCode], ["FAILED", "expired"]);
  assert.deepEqual([recipientOf(f, E(2)[1]).status, recipientOf(f, E(2)[1]).errorCode], ["FAILED", "attempts_exhausted"]);
  assert.deepEqual([campaignRow(f).status, campaignRow(f).failedCount], ["COMPLETED", 2]);
  assert.equal(smtp.mails.length, 0);
});

test("reconciling is idempotent and the counts always satisfy the database rule (sent + failed + skipped <= recipients)", async () => {
  const f = await ready(4);
  await unsubscribeEmail(E(4)[0], "LINK", { db: D(), now: NOW });
  smtp.behaviour = async (m: any) => (m.to === E(4)[1] ? smtpFails("EENVELOPE")() : { messageId: "<i@g>", accepted: [m.to], rejected: [] });
  await run();
  const once = JSON.stringify([campaignRow(f), f.recipients()]);
  for (let i = 0; i < 3; i++) await reconcileCampaign(f.campaignId, { db: D(), now: at(5_000) });
  const c = campaignRow(f);
  assert.deepEqual([c.sentCount, c.failedCount, c.skippedCount, c.recipientCount], [2, 1, 1, 4]);
  assert.ok(c.sentCount + c.failedCount + c.skippedCount <= c.recipientCount);
  assert.equal(JSON.stringify([campaignRow(f), f.recipients()]), once, "no change on repeat (including completedAt)");
  for (const r of f.recipients()) assert.equal(r.status === "SKIPPED", r.skipReason !== null);
});

test("a QUEUED recipient whose job has vanished is failed with job_missing instead of waiting forever", async () => {
  const f = await ready(1);
  await (db as any).emailCampaignRecipient.update({ where: { id: recipientOf(f, E(1)[0]).id }, data: { emailJobId: null } });
  await reconcileCampaign(f.campaignId, { db: D(), now: NOW });
  assert.deepEqual([recipientOf(f, E(1)[0]).status, recipientOf(f, E(1)[0]).errorCode], ["FAILED", "job_missing"]);
  assert.equal(campaignRow(f).status, "COMPLETED");
});

test("a problem while updating the campaign after a send never breaks the queue or the e-mail that was already accepted", async () => {
  const f = await ready(1);
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailCampaign") d.updateMany = async () => { throw new Error("db hiccup"); };
    return d;
  };
  const w = await run();
  delete (db as any).delegate;
  assert.equal(w.sent, 1);
  assert.equal(jobs()[0].status, "SENT");
  await reconcileCampaign(f.campaignId, { db: D(), now: NOW }); // the next run repairs it
  assert.equal(recipientOf(f, E(1)[0]).status, "SENT");
  assert.equal(campaignRow(f).status, "COMPLETED");
});

test("delivering ONE job directly (not through a queue run) settles its recipient and campaign immediately, for success, permanent failure and a skip", async () => {
  const f = await ready(3);
  const opts = { db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW };
  assert.equal(await deliverEmailJob(jobOf(f, E(3)[0]).id, opts), "sent");
  assert.equal(recipientOf(f, E(3)[0]).status, "SENT", "no queue run was needed to record the delivery");
  assert.equal(campaignRow(f).sentCount, 1);

  smtp.behaviour = smtpFails("EENVELOPE");
  assert.equal(await deliverEmailJob(jobOf(f, E(3)[1]).id, opts), "failed");
  assert.deepEqual([recipientOf(f, E(3)[1]).status, recipientOf(f, E(3)[1]).errorCode], ["FAILED", "recipient_rejected"]);
  assert.equal(campaignRow(f).failedCount, 1);

  await unsubscribeEmail(E(3)[2], "LINK", { db: D(), now: NOW });
  assert.equal(await deliverEmailJob(jobOf(f, E(3)[2]).id, opts), "skipped");
  assert.deepEqual([recipientOf(f, E(3)[2]).status, recipientOf(f, E(3)[2]).skipReason], ["SKIPPED", "suppressed"]);
  const c = campaignRow(f);
  assert.deepEqual([c.status, c.sentCount, c.failedCount, c.skippedCount], ["COMPLETED", 1, 1, 1], "completed by the last settling job, with exact counts");
});
