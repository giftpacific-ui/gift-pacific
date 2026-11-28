/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prompt 10: campaign dispatch on the in-memory database, with the REAL queue, P08 eligibility and P09 services.
 * Concurrency tests here run on a fake database that serialises transactions: they prove the service logic, NOT PostgreSQL locking
 * (see tests/integration/email-campaign-dispatch.postgres.test.ts for the database-level guarantees).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { captureLogs, makeSmtp, NOW, scheduledCampaign, SMTP_ENV, T0, type Fixture } from "../setup/campaign-dispatch-fixture";
import { dispatchEmailCampaign } from "@/server/services/email-campaign-dispatch.service";
import { processEmailQueue } from "@/server/services/email-queue.service";
import { transitionEmailCampaignStatus } from "@/server/services/email-campaign.service";
import { unsubscribeEmail } from "@/server/services/email-unsubscribe.service";
import { suppressEmail } from "@/server/services/email-suppression.service";
import { withdrawMarketingConsent } from "@/server/services/marketing-consent.service";
import { emailDedupeKey } from "@/lib/email/queue-policy";

let db: FakeDb;
let smtp: ReturnType<typeof makeSmtp>;
let logs: ReturnType<typeof captureLogs>;
beforeEach(() => { db = freshDb(); smtp = makeSmtp(); discardAfter(); logs = captureLogs(); });
afterEach(() => logs.restore());

const D = () => db as never;
const go = (id: string, over: Record<string, unknown> = {}) => dispatchEmailCampaign(id, { db: D(), now: NOW, ...over }) as Promise<any>;
const run = (over: Record<string, unknown> = {}) => processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW, ...over });
const jobs = () => db.rows("emailJob");
const campaignRow = (id: string) => db.rows("emailCampaign").find((c) => c.id === id)!;
const byStatus = (f: Fixture, status: string) => f.recipients().filter((r) => r.status === status);
const E = (n: number) => Array.from({ length: n }, (_, i) => `user${i + 1}@example.com`);

/** The count rule the database enforces (EmailCampaign_counts_check): settled recipients never exceed the total. */
function assertCountsConsistent(f: Fixture) {
  const c = campaignRow(f.campaignId);
  const rows = f.recipients();
  assert.equal(c.recipientCount, rows.length, "recipientCount = recipient rows");
  assert.equal(c.sentCount, rows.filter((r) => r.status === "SENT").length);
  assert.equal(c.failedCount, rows.filter((r) => r.status === "FAILED").length);
  assert.equal(c.skippedCount, rows.filter((r) => r.status === "SKIPPED").length);
  assert.ok(c.sentCount + c.failedCount + c.skippedCount <= c.recipientCount);
  for (const r of rows) assert.equal(r.status === "SKIPPED", r.skipReason !== null, "SKIPPED <=> skipReason (the database CHECK)");
}

// ------------------------------------------------------------------------------------------------------------------------------ success

test("successful dispatch: one EmailJob per eligible recipient, linked to its recipient, QUEUED (not sent), campaign SENDING, nothing sent by the request", async () => {
  const f = await scheduledCampaign(db, E(3));
  const r = await go(f.campaignId);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.resumed, r.enqueued, r.skipped, r.failed, r.reusedJobs, r.status], [false, 3, 0, 0, 0, "SENDING"]);
  assert.deepEqual([r.counts.queued, r.counts.sent, r.counts.pending, r.counts.total], [3, 0, 0, 3]);
  assert.equal(smtp.opened, 0, "dispatch never opens an SMTP connection");
  assert.equal(smtp.mails.length, 0);
  assert.equal(jobs().length, 3);
  for (const j of jobs()) assert.deepEqual([j.kind, j.priority, j.status, j.attempts], ["campaign", 1, "PENDING", 0], "bulk priority: drained after transactional e-mail");
  const c = campaignRow(f.campaignId);
  assert.equal(c.status, "SENDING");
  assert.equal(c.startedAt.getTime(), NOW.getTime());
  assert.equal(c.completedAt, null, "enqueued is not completed");
  assertCountsConsistent(f);
});

test("linkage: every recipient points at ITS job (address, key and campaign reference are right); keys hold no address; the message is personalised", async () => {
  const f = await scheduledCampaign(db, E(3));
  await go(f.campaignId);
  const ids = new Set<string>();
  for (const rec of f.recipients()) {
    assert.equal(rec.status, "QUEUED");
    assert.ok(rec.queuedAt instanceof Date);
    assert.equal(rec.skipReason, null);
    ids.add(rec.emailJobId);
    const job = jobs().find((j) => j.id === rec.emailJobId)!;
    const contact = db.rows("emailContact").find((c) => c.id === rec.contactId)!;
    assert.equal(job.toEmail, contact.email);
    assert.equal(job.dedupeKey, emailDedupeKey("campaign", [f.campaignId, rec.id]));
    assert.ok(!job.dedupeKey.includes("example"));
    const first = contact.name.split(" ")[0];
    assert.equal(job.subject, `Hi ${first}`);
    const url = job.text.match(/Unsubscribe: (\S+)$/)![1];
    assert.match(url, /^https:\/\/shop\.example\.com\/api\/email\/unsubscribe\/[A-Za-z0-9_-]{43}$/, "the recipient's own unsubscribe URL");
    assert.equal(job.text, `Hello ${contact.name}, welcome to Gift Pacific. Unsubscribe: ${url}`);
    assert.equal(job.html, `<p>Hello ${contact.name}</p><p><a href="${url}">Unsubscribe</a></p>`);
  }
  assert.equal(ids.size, 3, "one job per recipient");
  assert.equal(db.rows("emailCampaign").find((c) => c.id === f.campaignId)!.templateId, f.templateId, "campaign references are preserved");
});

test("queued versus delivered: after dispatch nothing is SENT; only the worker's SMTP result makes it so, and only then the campaign completes", async () => {
  const f = await scheduledCampaign(db, E(3));
  await go(f.campaignId);
  assert.equal(byStatus(f, "SENT").length, 0);
  const w = await run();
  assert.equal(w.sent, 3);
  assert.equal(smtp.mails.length, 3);
  assert.equal(byStatus(f, "SENT").length, 3);
  for (const r of byStatus(f, "SENT")) assert.ok(r.sentAt instanceof Date);
  const c = campaignRow(f.campaignId);
  assert.deepEqual([c.status, c.sentCount, c.failedCount, c.skippedCount, c.completedAt?.getTime()], ["COMPLETED", 3, 0, 0, NOW.getTime()]);
  assertCountsConsistent(f);
});

// ---------------------------------------------------------------------------------------------------------------------- invalid requests

test("invalid campaign status or id is refused with a clear reason and nothing is written", async () => {
  const f = await scheduledCampaign(db, E(2));
  const snapshot = () => JSON.stringify([campaignRow(f.campaignId), f.recipients(), jobs()]);
  const before = snapshot();
  assert.equal((await go("missing")).reason, "not_found");
  assert.equal((await go(42 as never)).reason, "not_found");
  assert.equal((await go("a b")).reason, "not_found");
  assert.equal((await go(f.campaignId, { now: T0 })).reason, "not_due", "scheduled for later");
  for (const status of ["DRAFT", "COMPLETED", "CANCELLED", "FAILED"]) {
    const row = db.insert("emailCampaign", { name: `S-${status}`, status, subject: "s", textBody: "b", recipientCount: 1, completedAt: status === "COMPLETED" ? NOW : null });
    const r = await go(row.id);
    assert.equal(r.reason, "invalid_status", status);
    assert.match(r.message, /cannot be dispatched/);
  }
  assert.equal(snapshot(), before, "the scheduled campaign, its recipients and the queue are untouched");
  assert.equal(jobs().length, 0);
  assert.equal(smtp.opened, 0);
});

test("a campaign without prepared recipients or with an invalid snapshot is refused", async () => {
  const f = await scheduledCampaign(db, E(1));
  const empty = db.insert("emailCampaign", { name: "Empty", status: "SCHEDULED", scheduledAt: T0, subject: "s", textBody: "b {{unsubscribeUrl}}", recipientCount: 0 });
  assert.equal((await go(empty.id)).reason, "no_recipients");
  const noRows = db.insert("emailCampaign", { name: "Count but no rows", status: "SCHEDULED", scheduledAt: T0, subject: "s", textBody: "b {{unsubscribeUrl}}", recipientCount: 5 });
  assert.equal((await go(noRows.id)).reason, "no_recipients");

  await (db as any).emailCampaign.update({ where: { id: f.campaignId }, data: { textBody: "Hi {{notAllowed}}" } });
  const bad = await go(f.campaignId);
  assert.equal(bad.reason, "invalid_snapshot");
  assert.ok(bad.errors.some((e: any) => e.code === "unsupported_variable"));
  await (db as any).emailCampaign.update({ where: { id: f.campaignId }, data: { htmlBody: "<script>x</script>", textBody: "ok {{unsubscribeUrl}}" } });
  assert.equal((await go(f.campaignId)).reason, "invalid_snapshot");
  assert.equal(jobs().length, 0);
  assert.equal(campaignRow(f.campaignId).status, "SCHEDULED");
});

test("a campaign whose recipients are ALL ineligible is rejected: it stays SCHEDULED and nothing is queued or rewritten", async () => {
  const f = await scheduledCampaign(db, E(2));
  for (const e of E(2)) await unsubscribeEmail(e, "LINK", { db: D(), now: T0 });
  const r = await go(f.campaignId);
  assert.equal(r.reason, "no_eligible_recipients");
  assert.equal(campaignRow(f.campaignId).status, "SCHEDULED");
  assert.equal(campaignRow(f.campaignId).startedAt, null);
  assert.equal(jobs().length, 0);
  assert.deepEqual(f.recipients().map((x) => x.status), ["PENDING", "PENDING"]);
});

// ------------------------------------------------------------------------------------------------------- eligibility is re-checked now

test("eligibility changes after audience preparation: unsubscribed, suppressed, bounced, complained, withdrawn and inactive contacts get no job", async () => {
  const emails = ["ok@example.com", "unsub@example.com", "manual@example.com", "bounce@example.com", "complain@example.com", "withdrawn@example.com", "inactive@example.com"];
  const f = await scheduledCampaign(db, emails);
  await unsubscribeEmail("unsub@example.com", "LINK", { db: D(), now: NOW });
  await suppressEmail("manual@example.com", { reason: "ADMIN" }, { db: D(), now: NOW });
  await suppressEmail("bounce@example.com", { reason: "BOUNCED" }, { db: D(), now: NOW });
  await suppressEmail("complain@example.com", { reason: "COMPLAINED" }, { db: D(), now: NOW });
  await withdrawMarketingConsent(f.contacts["withdrawn@example.com"].contact.id, "ADMIN", { db: D(), now: NOW });
  await (db as any).emailContact.update({ where: { id: f.contacts["inactive@example.com"].contact.id }, data: { isActive: false } });

  const r = await go(f.campaignId);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.enqueued, r.skipped], [1, 6]);
  assert.deepEqual(jobs().map((j) => j.toEmail), ["ok@example.com"]);
  const reasonOf = (e: string) => f.recipients().find((x) => x.contactId === f.contacts[e].contact.id)!;
  assert.equal(reasonOf("ok@example.com").status, "QUEUED");
  for (const e of emails.slice(1, 5)) assert.deepEqual([reasonOf(e).status, reasonOf(e).skipReason, reasonOf(e).emailJobId], ["SKIPPED", "suppressed", null], e);
  assert.deepEqual([reasonOf("withdrawn@example.com").status, reasonOf("withdrawn@example.com").skipReason], ["SKIPPED", "no_consent"]);
  assert.deepEqual([reasonOf("inactive@example.com").status, reasonOf("inactive@example.com").skipReason], ["SKIPPED", "inactive"]);
  assertCountsConsistent(f);
  assert.equal(campaignRow(f.campaignId).skippedCount, 6);
});

test("a recipient who unsubscribes after preparation never receives the e-mail (dispatch AND worker)", async () => {
  const f = await scheduledCampaign(db, E(2));
  await unsubscribeEmail(E(2)[1], "LINK", { db: D(), now: NOW });
  await go(f.campaignId);
  await run();
  assert.deepEqual(smtp.mails.map((m) => m.to), [E(2)[0]]);
});

test("unverifiable eligibility is excluded (fail closed): a failing check, and a stored contact that cannot be read", async () => {
  const f = await scheduledCampaign(db, E(3));
  await (db as any).emailContact.update({ where: { id: f.contacts[E(3)[2]].contact.id }, data: { isActive: "yes" } });
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailSuppression") { const ff = d.findFirst.bind(d); d.findFirst = async (a: any) => { if (a?.where?.email === E(3)[1]) throw new Error("db down"); return ff(a); }; }
    return d;
  };
  const r = await go(f.campaignId);
  delete (db as any).delegate;
  assert.ok(r.ok);
  assert.deepEqual([r.enqueued, r.skipped], [1, 2]);
  assert.deepEqual(jobs().map((j) => j.toEmail), [E(3)[0]]);
  for (const e of E(3).slice(1)) assert.deepEqual(f.recipients().filter((x) => x.contactId === f.contacts[e].contact.id).map((x) => [x.status, x.skipReason]), [["SKIPPED", "unverifiable"]], e);
});

test("checkout-progress consent is not marketing consent: a recipient row for a contact with only IncompleteCheckout.consentAt is skipped", async () => {
  const f = await scheduledCampaign(db, E(1));
  const cart = await (db as any).emailContact.create({ data: { email: "cart@example.com", source: "MANUAL" } });
  db.insert("incompleteCheckout", { email: "cart@example.com", consentAt: T0 });
  await (db as any).emailCampaignRecipient.create({ data: { campaignId: f.campaignId, contactId: cart.id } }); // a forged/stale row
  await go(f.campaignId);
  const row = f.recipients().find((x) => x.contactId === cart.id)!;
  assert.deepEqual([row.status, row.skipReason], ["SKIPPED", "no_consent"]);
  assert.deepEqual(jobs().map((j) => j.toEmail), [E(1)[0]]);
});

test("a recipient whose contact row is gone is skipped as no_contact", async () => {
  const f = await scheduledCampaign(db, E(2));
  const orphan = f.recipients()[1];
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailContact") { const fm = d.findMany.bind(d); d.findMany = async (a: any) => (await fm(a)).filter((c: any) => c.id !== orphan.contactId); }
    return d;
  };
  const r = await go(f.campaignId);
  delete (db as any).delegate;
  assert.deepEqual([r.enqueued, r.skipped], [1, 1]);
  assert.deepEqual(f.recipients().find((x) => x.id === orphan.id)!.skipReason, "no_contact");
});

// -------------------------------------------------------------------------------------------------------- duplicates, concurrency, resume

test("a repeated dispatch request creates no second job and reports that everything was already processed", async () => {
  const f = await scheduledCampaign(db, E(3));
  await go(f.campaignId);
  const snapshot = JSON.stringify([jobs(), f.recipients()]);
  const again = await go(f.campaignId);
  assert.equal(again.reason, "already_dispatched");
  assert.equal(JSON.stringify([jobs(), f.recipients()]), snapshot, "nothing changed");
  assert.equal(jobs().length, 3);
});

test("EmailJob de-duplication: a job that already exists for a recipient is reused and linked, never duplicated", async () => {
  const f = await scheduledCampaign(db, E(3));
  const first = f.recipients()[0];
  const contact = db.rows("emailContact").find((c) => c.id === first.contactId)!;
  const existing = db.insert("emailJob", { kind: "campaign", dedupeKey: emailDedupeKey("campaign", [f.campaignId, first.id])!, priority: 1, toEmail: contact.email, subject: "old", text: "old", status: "PENDING", attempts: 0, nextAttemptAt: NOW });
  const r = await go(f.campaignId);
  assert.ok(r.ok);
  assert.equal(r.reusedJobs, 1);
  assert.equal(jobs().length, 3, "two new jobs and the one that existed");
  assert.equal(f.recipients().find((x) => x.id === first.id)!.emailJobId, existing.id);
  assert.equal(jobs().find((j) => j.id === existing.id)!.subject, "old", "the existing job is left as it was");
});

test("concurrent dispatch requests: exactly one starts the campaign, and no recipient ever gets two jobs", async () => {
  const f = await scheduledCampaign(db, E(8), { chunkSize: 3 });
  const results: any[] = await Promise.all(Array.from({ length: 6 }, () => go(f.campaignId, { chunkSize: 3 })));
  const started = results.filter((r) => r.ok && r.resumed === false);
  assert.equal(started.length, 1, JSON.stringify(results.map((r) => r.ok ? ["ok", r.resumed, r.enqueued] : r.reason)));
  for (const r of results) assert.ok(r.ok || ["already_dispatching", "already_dispatched", "campaign_not_sending"].includes(r.reason), JSON.stringify(r));
  assert.equal(results.reduce((n, r) => n + (r.ok ? r.enqueued : 0), 0), 8, "each recipient was queued exactly once across all callers");
  assert.equal(jobs().length, 8);
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 8);
  assert.equal(new Set(f.recipients().map((r) => r.emailJobId)).size, 8);
  assert.ok(f.recipients().every((r) => r.status === "QUEUED"));
});

test("a partial dispatch failure rolls back only the failing chunk, leaves the campaign resumable, and the resume duplicates nothing", async () => {
  const f = await scheduledCampaign(db, E(5), { chunkSize: 2 });
  const orig = (db as any).delegate.bind(db);
  let calls = 0;
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailJob") { const cm = d.createMany.bind(d); d.createMany = async (a: any) => { calls++; if (calls === 2) { await cm({ ...a, data: a.data.slice(0, 1) }); throw new Error("disk full"); } return cm(a); }; }
    return d;
  };
  const r = await go(f.campaignId, { chunkSize: 2 });
  delete (db as any).delegate;
  assert.equal(r.reason, "interrupted");
  assert.deepEqual(r.progress, { enqueued: 2, reusedJobs: 0, skipped: 0, failed: 0 }, "only the committed chunk is counted");
  assert.equal(jobs().length, 2, "the failed chunk's partial insert was rolled back: no orphan job");
  assert.equal(byStatus(f, "QUEUED").length, 2);
  assert.equal(byStatus(f, "PENDING").length, 3);
  assert.ok(byStatus(f, "QUEUED").every((x) => jobs().some((j) => j.id === x.emailJobId)), "no recipient points at a missing job");
  assert.equal(campaignRow(f.campaignId).status, "SENDING", "resumable, not failed, not completed");
  assert.ok(!JSON.stringify(logs.lines).includes("@example.com"));

  const resumed = await go(f.campaignId, { chunkSize: 2 });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.deepEqual([resumed.resumed, resumed.enqueued], [true, 3]);
  assert.equal(jobs().length, 5);
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 5);
  assert.equal(byStatus(f, "QUEUED").length, 5);
  assertCountsConsistent(f);
  assert.equal((await go(f.campaignId)).reason, "already_dispatched");
});

test("a recipient that fails while others succeed does not duplicate or block the rest: an unusable personalised subject becomes FAILED(invalid_message)", async () => {
  const f = await scheduledCampaign(db, E(3), { subject: "Hello {{customerName}}" });
  await (db as any).emailContact.update({ where: { id: f.contacts[E(3)[1]].contact.id }, data: { name: "n".repeat(300) } });
  const r = await go(f.campaignId);
  assert.ok(r.ok);
  assert.deepEqual([r.enqueued, r.failed], [2, 1]);
  const bad = f.recipients().find((x) => x.contactId === f.contacts[E(3)[1]].contact.id)!;
  assert.deepEqual([bad.status, bad.errorCode, bad.skipReason, bad.emailJobId], ["FAILED", "invalid_message", null, null]);
  assert.equal(jobs().length, 2);
  assertCountsConsistent(f);
});

test("cancelling a campaign during dispatch stops it: remaining recipients are not queued", async () => {
  const f = await scheduledCampaign(db, E(6), { chunkSize: 2 });
  const origTx = (db as any).$transaction.bind(db);
  let txs = 0;
  (db as any).$transaction = async (...args: any[]) => {
    txs++;
    if (txs === 2) await transitionEmailCampaignStatus(f.campaignId, "CANCELLED", { db: db as never, now: NOW });
    return origTx(...args);
  };
  const r = await go(f.campaignId, { chunkSize: 2 });
  delete (db as any).$transaction;
  assert.equal(r.reason, "campaign_not_sending");
  assert.equal(r.progress.enqueued, 2);
  assert.equal(jobs().length, 2);
  assert.equal(byStatus(f, "PENDING").length, 4);
  assert.equal(campaignRow(f.campaignId).status, "CANCELLED");
});

// -------------------------------------------------------------------------------------------------------------------------- safety

test("nothing sensitive is logged by dispatch and delivery, including on SMTP failure: no address, subject, body, SMTP password or token", async () => {
  const f = await scheduledCampaign(db, E(3));
  await go(f.campaignId);
  smtp.behaviour = async () => { throw Object.assign(new Error(`rejected ${E(3)[0]} ${"abcdefghijklmnop"}`), { code: "ETIMEDOUT" }); };
  await run(); // retry path
  await unsubscribeEmail(E(3)[1], "LINK", { db: D(), now: NOW });
  await run({ now: new Date(NOW.getTime() + 2 * 3_600_000) }); // gate path (one recipient now unsubscribed)
  const text = logs.lines.join("\n");
  assert.ok(logs.lines.length > 0, "something was logged, so the check below is meaningful");
  assert.ok(!/@example\.com/.test(text), "no e-mail address");
  assert.ok(!/Hello |welcome to/.test(text), "no subject or body");
  assert.ok(!text.includes("abcdefghijklmnop"), "no SMTP password");
  assert.ok(!/token/i.test(text), "no unsubscribe token");
});

test("dispatch changes no consent or suppression record; the only contact change is the stable token HASH of the contacts that got an e-mail", async () => {
  const f = await scheduledCampaign(db, E(3));
  await unsubscribeEmail(E(3)[2], "LINK", { db: D(), now: NOW });
  const snap = () => JSON.stringify([db.rows("marketingConsent"), db.rows("emailSuppression")]);
  const contactsWithoutHash = () => JSON.stringify(db.rows("emailContact").map(({ unsubscribeTokenHash: _h, ...rest }) => rest));
  const before = snap();
  const contactsBefore = contactsWithoutHash();
  await go(f.campaignId);
  await run();
  assert.equal(snap(), before, "consents and suppressions untouched");
  assert.equal(contactsWithoutHash(), contactsBefore, "no other contact field changed");
  const unsubscribed = db.rows("emailContact").find((c) => c.email === E(3)[2])!;
  assert.equal(unsubscribed.unsubscribeTokenHash, null, "an unsubscribed recipient was skipped, so no link was created for it");
  for (const c of db.rows("emailContact").filter((c) => c.email !== E(3)[2])) assert.match(c.unsubscribeTokenHash, /^[0-9a-f]{64}$/, "only the SHA-256 of the token is stored");
});

test("the dispatch request itself never sends, even when SMTP is fully configured", async () => {
  const f = await scheduledCampaign(db, E(2));
  const r = await go(f.campaignId, { env: SMTP_ENV, factory: smtp.factory });
  assert.ok(r.ok);
  assert.equal(smtp.opened, 0);
  assert.equal(smtp.mails.length, 0);
});
