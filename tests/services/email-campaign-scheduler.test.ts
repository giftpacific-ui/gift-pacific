/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prompt 12: campaign scheduling validation, the automated due-campaign dispatcher, and the cron route. Everything goes through the real services
 * (transitionEmailCampaignStatus, dispatchDueCampaigns -> dispatchEmailCampaign -> the EXISTING queue and worker) on the in-memory database, which
 * serialises transactions: it proves the logic and the ordering of the guards, not PostgreSQL's row locking (see the PostgreSQL integration file).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { captureLogs, makeSmtp, NOW, scheduledCampaign, SMTP_ENV, T0, T1, UNSUB_BASE, UNSUB_SECRET, type Fixture } from "../setup/campaign-dispatch-fixture";
import { transitionEmailCampaignStatus } from "@/server/services/email-campaign.service";
import { CAMPAIGN_RESUME_STALE_MS, DUE_CAMPAIGN_DEFAULT_LIMIT, dispatchDueCampaigns } from "@/server/services/email-campaign-scheduler.service";
import { enqueueEmail, processEmailQueue } from "@/server/services/email-queue.service";
import { suppressEmail } from "@/server/services/email-suppression.service";
import { withdrawMarketingConsent } from "@/server/services/marketing-consent.service";
import { GET, POST } from "@/app/api/email/campaigns/dispatch/route";

let db: FakeDb;
let seq = 0;
let smtp: ReturnType<typeof makeSmtp>;
let logs: ReturnType<typeof captureLogs>;
beforeEach(() => { seq = 0; db = freshDb(); smtp = makeSmtp(); discardAfter(); logs = captureLogs(); });
afterEach(() => logs.restore());

const D = () => db as never;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const E = (n: number) => Array.from({ length: n }, (_, i) => `user${i + 1}@example.com`);
const GOOD_ENV = { EMAIL_UNSUBSCRIBE_SECRET: UNSUB_SECRET, NEXT_PUBLIC_APP_URL: UNSUB_BASE };
const jobs = () => db.rows("emailJob");
const camp = (id: string) => db.rows("emailCampaign").find((c) => c.id === id)!;
const recipientsOf = (id: string) => db.rows("emailCampaignRecipient").filter((r) => r.campaignId === id);
const sweep = (over: Record<string, unknown> = {}) => dispatchDueCampaigns({ db: D(), now: NOW, unsubscribeEnv: GOOD_ENV, ...over });
const run = () => processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW });
/** A SCHEDULED campaign that is due at NOW, "idle" since T0 (the in-memory database does not maintain updatedAt, so tests set it as Prisma would). */
async function due(over: Record<string, unknown> = {}, emails = E(2), when: Date = T1): Promise<Fixture> {
  const n = ++seq;
  const f = await scheduledCampaign(db, emails, { name: `Campaign ${n}`, reuse: db.rows("emailContact").length > 0, legacy: true, ...over });
  db.patch("emailCampaign", f.campaignId, { scheduledAt: when, updatedAt: T0 });
  return f;
}
const summaryOf = (s: any) => [s.processed, s.dispatched, s.resumed, s.skipped, s.failed, s.hasMore];

// ================================================================================================================ scheduling validation

const FUTURE = "2026-11-25T12:00:00.000Z";
/** A DRAFT with a prepared audience (the shape the P09 flow produces). */
async function draft(over: Record<string, unknown> = {}) {
  const f = await scheduledCampaign(db, E(2), { legacy: true, ...over });
  db.patch("emailCampaign", f.campaignId, { status: "DRAFT", scheduledAt: null });
  return f;
}
const schedule = (f: Fixture, extra: Record<string, unknown> = {}) => transitionEmailCampaignStatus(f.campaignId, "SCHEDULED", { db: D(), now: NOW, scheduledAt: FUTURE, unsubscribeEnv: GOOD_ENV, ...extra }) as Promise<any>;
/** A refused scheduling must leave the campaign byte-for-byte as it was: still DRAFT, no time, nothing queued. */
async function refused(f: Fixture, reason: string, extra: Record<string, unknown> = {}) {
  const before = camp(f.campaignId);
  const r = await schedule(f, extra);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, reason, JSON.stringify(r));
  assert.deepEqual(camp(f.campaignId), before, "the campaign is exactly as it was");
  assert.equal(jobs().length, 0);
  return r;
}

test("SCHEDULE: a valid draft is scheduled, with its time", async () => {
  const f = await draft();
  const r = await schedule(f);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([camp(f.campaignId).status, camp(f.campaignId).scheduledAt.toISOString()], ["SCHEDULED", FUTURE]);
  assert.equal(jobs().length, 0, "scheduling queues nothing");
});

test("SCHEDULE: a text body without {{unsubscribeUrl}} is refused (unsubscribe_link_missing), and nothing changes", async () => {
  const r = await refused(await draft({ textBody: "Hello {{customerName}}", htmlBody: "<p>{{unsubscribeUrl}}</p>" }), "unsubscribe_link_missing");
  assert.ok(r.errors.some((e: any) => e.field === "textBody" && e.code === "unsubscribe_link_missing"));
});

test("SCHEDULE: an HTML body without {{unsubscribeUrl}} is refused when HTML exists; a text-only campaign needs the text placeholder only", async () => {
  const r = await refused(await draft({ htmlBody: "<p>no link</p>" }), "unsubscribe_link_missing");
  assert.ok(r.errors.some((e: any) => e.field === "htmlBody"));
  db = freshDb(); discardAfter();
  const textOnly = await draft({ htmlBody: null });
  assert.ok((await schedule(textOnly)).ok);
});

test("SCHEDULE: {{unsubscribeUrl}} in the subject is refused", async () => {
  const r = await refused(await draft({ subject: "Leave {{unsubscribeUrl}}" }), "unsubscribe_link_missing");
  assert.ok(r.errors.some((e: any) => e.field === "subject" && e.code === "unsubscribe_url_in_subject"));
});

test("SCHEDULE: a missing, weak or reused unsubscribe secret is refused (unsubscribe_link_unavailable); the message never contains the secret", async () => {
  const weak = "short-secret";
  const reused = "R".repeat(40);
  for (const env of [
    { NEXT_PUBLIC_APP_URL: UNSUB_BASE },
    { ...GOOD_ENV, EMAIL_UNSUBSCRIBE_SECRET: "" },
    { ...GOOD_ENV, EMAIL_UNSUBSCRIBE_SECRET: weak },
    { ...GOOD_ENV, EMAIL_UNSUBSCRIBE_SECRET: "x".repeat(40) },
    { ...GOOD_ENV, EMAIL_UNSUBSCRIBE_SECRET: reused, CRON_SECRET: reused },
  ]) {
    db = freshDb(); discardAfter();
    const r = await refused(await draft(), "unsubscribe_link_unavailable", { unsubscribeEnv: env });
    assert.ok(![weak, reused, "x".repeat(40)].some((v) => JSON.stringify(r).includes(v)), "no secret in the response");
  }
});

test("SCHEDULE: an invalid public base URL is refused for the environment (http, a path, credentials, garbage, missing in production)", async () => {
  for (const base of ["http://shop.example.com", "https://shop.example.com/store", "https://user:pw@shop.example.com", "not a url", "ftp://shop.example.com", "https://localhost"]) {
    db = freshDb(); discardAfter();
    await refused(await draft(), "unsubscribe_link_unavailable", { unsubscribeEnv: { ...GOOD_ENV, NEXT_PUBLIC_APP_URL: base, NODE_ENV: "production" } });
  }
  db = freshDb(); discardAfter();
  await refused(await draft(), "unsubscribe_link_unavailable", { unsubscribeEnv: { EMAIL_UNSUBSCRIBE_SECRET: UNSUB_SECRET, NODE_ENV: "production" } });
});

test("SCHEDULE: a missing, invalid, past or too-distant time is refused (invalid_input) and nothing changes", async () => {
  for (const scheduledAt of [undefined, null, "", "tomorrow", "2026-13-45T00:00:00Z", "2026-11-25", NOW.toISOString(), "2026-11-25T09:59:59.000Z", new Date("invalid"), "2028-01-01T00:00:00.000Z", 12345]) {
    db = freshDb(); discardAfter();
    await refused(await draft(), "invalid_input", { scheduledAt });
  }
});

test("SCHEDULE: an audience that is only a stored number is refused (no PENDING recipient rows), and so is a campaign that is not a DRAFT", async () => {
  const noRows = await draft();
  db.remove("emailCampaignRecipient", (r) => r.campaignId === noRows.campaignId);
  await refused(noRows, "no_recipients");
  db = freshDb(); discardAfter();
  const settled = await draft();
  for (const r of settled.recipients()) db.patch("emailCampaignRecipient", r.id, { status: "SKIPPED" });
  await refused(settled, "no_recipients");
  db = freshDb(); discardAfter();
  const f = await draft();
  for (const status of ["SENDING", "COMPLETED", "CANCELLED", "FAILED", "SCHEDULED"]) {
    db.patch("emailCampaign", f.campaignId, { status });
    const before = camp(f.campaignId);
    assert.equal((await schedule(f)).reason, "invalid_transition", status);
    assert.deepEqual(camp(f.campaignId), before);
  }
});

test("SCHEDULE: the checks run in the service, not the caller: an invalid campaign cannot reach SCHEDULED through it with any input", async () => {
  const f = await draft({ textBody: "no link at all", htmlBody: null });
  for (const scheduledAt of [FUTURE, "2026-11-30T00:00:00.000Z"]) assert.equal((await schedule(f, { scheduledAt })).ok, false);
  assert.equal(camp(f.campaignId).status, "DRAFT");
});

// ================================================================================================================ automated dispatch

test("DISPATCH: a due campaign is dispatched: every recipient is queued once with its link, and the campaign is SENDING (never COMPLETED by queuing)", async () => {
  const f = await due();
  const s = await sweep();
  assert.deepEqual(summaryOf(s), [1, 1, 0, 0, 0, false]);
  assert.equal(camp(f.campaignId).status, "SENDING");
  assert.deepEqual(recipientsOf(f.campaignId).map((r) => r.status), ["QUEUED", "QUEUED"]);
  assert.equal(jobs().length, 2);
  for (const j of jobs()) assert.match(j.text, /Unsubscribe: https:\/\/shop\.example\.com\/api\/email\/unsubscribe\//);
  assert.equal(smtp.mails.length, 0, "the dispatcher queues; it never sends");
});

test("DISPATCH: the due time is inclusive; a campaign due one millisecond later is not dispatched", async () => {
  const exact = await due({}, E(1), NOW);
  const later = await due({}, E(1), at(1));
  const s = await sweep();
  assert.deepEqual(summaryOf(s), [1, 1, 0, 0, 0, false]);
  assert.equal(camp(exact.campaignId).status, "SENDING");
  assert.deepEqual([camp(later.campaignId).status, recipientsOf(later.campaignId).every((r) => r.status === "PENDING")], ["SCHEDULED", true]);
});

test("DISPATCH: a future campaign is not dispatched", async () => {
  const f = await due({}, E(2), at(3_600_000));
  const s = await sweep();
  assert.deepEqual(summaryOf(s), [0, 0, 0, 0, 0, false]);
  assert.deepEqual([camp(f.campaignId).status, jobs().length], ["SCHEDULED", 0]);
});

test("DISPATCH: DRAFT, CANCELLED, COMPLETED, FAILED campaigns (even with a past time) and a SENDING one with nothing left to queue are never dispatched", async () => {
  const states: Record<string, any> = { DRAFT: {}, CANCELLED: { cancelledAt: T0 }, COMPLETED: { completedAt: T0 }, FAILED: { failureReason: "x" } };
  const ids: Record<string, string> = {};
  for (const [status, extra] of Object.entries(states)) { const f = await due({}, E(1)); db.patch("emailCampaign", f.campaignId, { status, ...extra }); ids[status] = f.campaignId; }
  const sending = await due({}, E(1));
  db.patch("emailCampaign", sending.campaignId, { status: "SENDING", startedAt: T0 });
  for (const r of recipientsOf(sending.campaignId)) db.patch("emailCampaignRecipient", r.id, { status: "QUEUED" });
  const before = db.rows("emailCampaign");
  const s = await sweep({ limit: 10 });
  assert.deepEqual(summaryOf(s), [0, 0, 0, 0, 0, false]);
  assert.deepEqual(db.rows("emailCampaign"), before, "not a single campaign row was touched");
  assert.equal(jobs().length, 0);
  assert.deepEqual(Object.keys(ids).sort(), ["CANCELLED", "COMPLETED", "DRAFT", "FAILED"]);
});

test("DISPATCH: repeated invocation creates no duplicate jobs and does nothing the second time", async () => {
  const f = await due({}, E(3));
  assert.equal((await sweep()).dispatched, 1);
  const first = jobs().map((j) => j.id).sort();
  for (let i = 0; i < 3; i++) assert.deepEqual(summaryOf(await sweep()), [0, 0, 0, 0, 0, false]);
  assert.deepEqual(jobs().map((j) => j.id).sort(), first);
  assert.equal(jobs().length, 3);
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 3);
  assert.equal(camp(f.campaignId).status, "SENDING");
});

test("DISPATCH: concurrent invocations dispatch the campaign exactly once: one wins the claim, the others skip it, no duplicate job", async () => {
  const f = await due({}, E(5));
  const results = await Promise.all(Array.from({ length: 5 }, () => sweep()));
  assert.equal(results.reduce((n, s) => n + s.dispatched, 0), 1, "exactly one invocation dispatched it");
  assert.equal(results.reduce((n, s) => n + s.skipped, 0), 4, "the other four only skipped it");
  assert.equal(results.reduce((n, s) => n + s.failed, 0), 0);
  assert.equal(jobs().length, 5);
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 5);
  assert.ok(recipientsOf(f.campaignId).every((r) => r.status === "QUEUED" && r.emailJobId));
});

test("DISPATCH: concurrent invocations over SEVERAL campaigns dispatch each exactly once", async () => {
  const fs = [await due({}, E(2)), await due({}, E(2)), await due({}, E(2))];
  const results = await Promise.all(Array.from({ length: 4 }, () => sweep({ limit: 10 })));
  assert.equal(results.reduce((n, s) => n + s.dispatched, 0), 3);
  assert.equal(jobs().length, 6);
  assert.deepEqual(fs.map((f) => camp(f.campaignId).status), ["SENDING", "SENDING", "SENDING"]);
});

test("DISPATCH: a campaign without a usable updatedAt is never claimed (never an unfiltered write) and is skipped", async () => {
  const f = await due();
  db.patch("emailCampaign", f.campaignId, { updatedAt: undefined });
  assert.deepEqual(summaryOf(await sweep()), [1, 0, 0, 1, 0, false]);
  assert.deepEqual([camp(f.campaignId).status, jobs().length], ["SCHEDULED", 0]);
});

test("PARTIAL DISPATCH: an interrupted campaign is NOT touched while it looks active, and is resumed after it has been idle; nothing already queued is duplicated", async () => {
  const f = await due({}, E(5));
  const orig = (db as any).delegate.bind(db);
  let calls = 0;
  (db as any).delegate = (t: string) => { const d = orig(t); if (t === "emailJob") { const cm = d.createMany.bind(d); d.createMany = async (a: any) => { calls++; if (calls === 2) throw new Error("disk full"); return cm(a); }; } return d; };
  const first = await sweep({ chunkSize: 2 });
  delete (db as any).delegate;
  assert.deepEqual(summaryOf(first), [1, 0, 0, 0, 1, false], "reported as failed (interrupted), not dispatched");
  assert.equal(camp(f.campaignId).status, "SENDING");
  assert.deepEqual([jobs().length, recipientsOf(f.campaignId).filter((r) => r.status === "PENDING").length], [2, 3]);
  const firstChunk = jobs().map((j) => j.id).sort();

  assert.deepEqual(summaryOf(await sweep({ chunkSize: 2 })), [0, 0, 0, 0, 0, false], "just touched: another run is (or may be) working on it");
  assert.equal(jobs().length, 2);

  const resumed = await sweep({ chunkSize: 2, now: at(CAMPAIGN_RESUME_STALE_MS + 1000) });
  assert.deepEqual(summaryOf(resumed), [1, 1, 1, 0, 0, false]);
  assert.equal(jobs().length, 5);
  assert.ok(firstChunk.every((id) => jobs().some((j) => j.id === id)), "the first chunk's jobs are the same rows");
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 5);
  assert.ok(recipientsOf(f.campaignId).every((r) => r.status === "QUEUED"));
  assert.deepEqual(summaryOf(await sweep({ now: at(2 * CAMPAIGN_RESUME_STALE_MS) })), [0, 0, 0, 0, 0, false], "nothing left to resume");
});

test("PARTIAL DISPATCH: concurrent resumes of one interrupted campaign: exactly one resumes it", async () => {
  const f = await due({}, E(4));
  db.patch("emailCampaign", f.campaignId, { status: "SENDING", startedAt: T0 }); // started earlier, then interrupted with everything still PENDING
  const later = at(CAMPAIGN_RESUME_STALE_MS + 1000);
  const results = await Promise.all(Array.from({ length: 4 }, () => sweep({ now: later })));
  assert.equal(results.reduce((n, s) => n + s.dispatched, 0), 1);
  assert.equal(results.reduce((n, s) => n + s.skipped, 0), 3);
  assert.equal(jobs().length, 4);
  assert.equal(recipientsOf(f.campaignId).filter((r) => r.status === "QUEUED").length, 4);
});

test("DEDUPLICATION: a recipient whose job already exists is re-linked to that same job on resume, never given a second one (P10 intact)", async () => {
  const f = await due({}, E(3));
  await sweep();
  const victim = recipientsOf(f.campaignId)[0];
  const jobId = victim.emailJobId;
  db.patch("emailCampaignRecipient", victim.id, { status: "PENDING", emailJobId: null, queuedAt: null });
  const s = await sweep({ now: at(CAMPAIGN_RESUME_STALE_MS + 1000) });
  assert.deepEqual([s.dispatched, s.resumed], [1, 1]);
  assert.equal(jobs().length, 3, "no fourth job");
  const after = recipientsOf(f.campaignId).find((r) => r.id === victim.id)!;
  assert.deepEqual([after.status, after.emailJobId], ["QUEUED", jobId]);
});

test("ISOLATION: a campaign that cannot be sent never enqueues anything, is closed as FAILED with its code, and does not block the next one", async () => {
  const bad = await due({ textBody: "no link at all", htmlBody: null }, E(2), new Date(T1.getTime() - 7_200_000));
  const good = await due({}, E(2));
  const s = await sweep();
  assert.deepEqual(summaryOf(s), [2, 1, 0, 0, 1, false]);
  assert.deepEqual([camp(bad.campaignId).status, camp(bad.campaignId).failureReason], ["FAILED", "unsubscribe_link_missing"]);
  assert.ok(recipientsOf(bad.campaignId).every((r) => r.status === "FAILED" && r.errorCode === "unsubscribe_link_missing" && !r.emailJobId), "nothing was queued for it, and none of its recipients is left PENDING");
  assert.equal(jobs().filter((j) => recipientsOf(bad.campaignId).some((r) => r.emailJobId === j.id)).length, 0);
  assert.equal(camp(good.campaignId).status, "SENDING");
  assert.equal(jobs().length, 2);
  assert.deepEqual(summaryOf(await sweep()), [0, 0, 0, 0, 0, false], "the closed campaign is not retried");
});

test("ISOLATION: a campaign whose audience is gone is closed as FAILED (no_recipients) and the others still go", async () => {
  const bad = await due({}, E(2), new Date(T1.getTime() - 60_000));
  db.remove("emailCampaignRecipient", (r) => r.campaignId === bad.campaignId);
  const good = await due({}, E(2));
  const s = await sweep();
  assert.deepEqual(summaryOf(s), [2, 1, 0, 0, 1, false]);
  assert.deepEqual([camp(bad.campaignId).status, camp(bad.campaignId).failureReason], ["FAILED", "no_recipients"]);
  assert.equal(camp(good.campaignId).status, "SENDING");
});

test("ISOLATION: a crash while handling one campaign is counted, leaves that campaign as it was, and the others are still processed", async () => {
  const crashing = await due({}, E(2), new Date(T1.getTime() - 60_000));
  const good = await due({}, E(2));
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailCampaign") { const fu = d.findUnique.bind(d); d.findUnique = async (a: any) => { if (a?.where?.id === crashing.campaignId) throw new Error("boom user1@example.com"); return fu(a); }; }
    return d;
  };
  const s = await sweep();
  delete (db as any).delegate;
  assert.deepEqual(summaryOf(s), [2, 1, 0, 0, 1, false]);
  assert.deepEqual([camp(crashing.campaignId).status, camp(crashing.campaignId).failureReason], ["SCHEDULED", null], "a crash is not a verdict: it stays SCHEDULED");
  assert.equal(camp(good.campaignId).status, "SENDING");
  assert.doesNotMatch(logs.lines.join("\n"), /user1@example|boom/);
});

test("FAIL CLOSED: missing unsubscribe configuration queues nothing, closes nothing, and the campaign goes out once configuration is back", async () => {
  const f = await due({}, E(2));
  for (const env of [{}, { EMAIL_UNSUBSCRIBE_SECRET: "weak" }, { EMAIL_UNSUBSCRIBE_SECRET: UNSUB_SECRET, NEXT_PUBLIC_APP_URL: "http://shop.example.com", NODE_ENV: "production" }]) {
    assert.deepEqual(summaryOf(await sweep({ unsubscribeEnv: env })), [1, 0, 0, 0, 1, false]);
    assert.deepEqual([camp(f.campaignId).status, camp(f.campaignId).failureReason, jobs().length], ["SCHEDULED", null, 0]);
    assert.ok(db.rows("emailContact").every((c) => !c.unsubscribeTokenHash), "no link was created either");
  }
  assert.deepEqual(summaryOf(await sweep()), [1, 1, 0, 0, 0, false]);
  assert.equal(jobs().length, 2);
});

test("BATCH: at most `limit` campaigns are taken per invocation, oldest due first, and hasMore says so; the next invocation takes the rest", async () => {
  const fs: Fixture[] = [];
  for (let i = 0; i < 5; i++) fs.push(await due({}, E(1), new Date(T1.getTime() - (10 - i) * 60_000)));
  const first = await sweep({ limit: 2 });
  assert.deepEqual(summaryOf(first), [2, 2, 0, 0, 0, true]);
  assert.deepEqual(fs.map((f) => camp(f.campaignId).status), ["SENDING", "SENDING", "SCHEDULED", "SCHEDULED", "SCHEDULED"]);
  const second = await sweep({ limit: 2 });
  assert.deepEqual(summaryOf(second), [2, 2, 0, 0, 0, true]);
  assert.deepEqual(summaryOf(await sweep({ limit: 2 })), [1, 1, 0, 0, 0, false]);
  assert.equal(jobs().length, 5);
});

test("BATCH: the default limit applies, and an invalid or oversized limit cannot lift it beyond the maximum", async () => {
  for (let i = 0; i < 14; i++) await due({}, E(1));
  assert.equal(DUE_CAMPAIGN_DEFAULT_LIMIT, 3);
  assert.equal((await sweep()).dispatched, 3);
  assert.equal((await sweep({ limit: 0 })).dispatched, 3);
  assert.equal((await sweep({ limit: Number.NaN })).dispatched, 3);
  assert.equal((await sweep({ limit: 1_000_000 })).dispatched, 5, "capped at the maximum of 10 per call; 5 were left");
});

test("BATCH: when the time budget is spent no new campaign is started, and hasMore is set", async () => {
  await due({}, E(1)); await due({}, E(1));
  const s = await sweep({ deadlineMs: -1 });
  assert.deepEqual(summaryOf(s), [0, 0, 0, 0, 0, true]);
  assert.equal(jobs().length, 0);
});

test("COUNTS: processed = dispatched + skipped + failed, whatever mix a run meets", async () => {
  await due({ textBody: "no link", htmlBody: null }); await due({}); const unclaimable = await due({}); db.patch("emailCampaign", unclaimable.campaignId, { updatedAt: undefined });
  const s = await sweep({ limit: 10 });
  assert.equal(s.processed, s.dispatched + s.skipped + s.failed);
  assert.deepEqual([s.processed, s.dispatched, s.skipped, s.failed], [3, 1, 1, 1]);
});

test("END TO END: the dispatcher queues, the EXISTING worker sends (campaign mail with List-Unsubscribe headers, transactional mail without), and the transactional job is untouched by the dispatcher", async () => {
  await due({}, E(2));
  await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["GP-9001"], to: "buyer@example.com", subject: "Your order", text: "Thanks" }, { db: D(), now: NOW, kick: false });
  const txBefore = jobs().find((j) => j.toEmail === "buyer@example.com")!;
  await sweep();
  assert.deepEqual(jobs().find((j) => j.id === txBefore.id), txBefore, "the dispatcher did not touch it");
  const w = await run();
  assert.equal(w.sent, 3);
  const tx = smtp.mails.find((m: any) => m.to === "buyer@example.com");
  assert.ok(tx && !tx.headers?.["List-Unsubscribe"], "transactional mail has no unsubscribe header");
  const campaignMails = smtp.mails.filter((m: any) => m.to !== "buyer@example.com");
  assert.equal(campaignMails.length, 2);
  for (const m of campaignMails) assert.ok(m.headers["List-Unsubscribe"] && m.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
});

test("LOGS: nothing sensitive is logged by the dispatcher (no address, link, secret or content), only ids, codes and counts", async () => {
  await due({ textBody: "no link", htmlBody: null }, E(1)); await due({}, E(1));
  await sweep();
  await sweep({ unsubscribeEnv: {} });
  assert.ok(logs.lines.length > 0);
  assert.doesNotMatch(logs.lines.join("\n"), /@example\.com|api\/email\/unsubscribe|test-only-unsubscribe-secret|Campaign \d|Hello/);
});

// ================================================================================================================ status transition consistency

test("TRANSITIONS: the management service still refuses SCHEDULED -> FAILED (and every other move to FAILED); nothing public was widened", async () => {
  const f = await draft();
  for (const from of ["DRAFT", "SCHEDULED", "COMPLETED", "CANCELLED", "FAILED"]) {
    db.patch("emailCampaign", f.campaignId, { status: from, scheduledAt: from === "SCHEDULED" ? T1 : null });
    const before = camp(f.campaignId);
    const r: any = await transitionEmailCampaignStatus(f.campaignId, "FAILED", { db: D(), now: NOW });
    assert.deepEqual([r.ok, r.reason], [false, "invalid_transition"], `${from} -> FAILED`);
    assert.deepEqual(camp(f.campaignId), before, "nothing changed");
  }
  db.patch("emailCampaign", f.campaignId, { status: "SENDING" });
  assert.equal(((await transitionEmailCampaignStatus(f.campaignId, "FAILED", { db: D(), now: NOW })) as any).reason, "transition_reserved", "unchanged: valid in the lifecycle but the sender's move");
});

test("TRANSITIONS: the permitted internal move closes a SCHEDULED campaign as FAILED, settles its recipients with it, and changes nothing else about it", async () => {
  const f = await due({ textBody: "no link at all", htmlBody: null });
  const before = camp(f.campaignId);
  await sweep();
  const after = camp(f.campaignId);
  assert.deepEqual([after.status, after.failureReason], ["FAILED", "unsubscribe_link_missing"]);
  assert.ok(after.updatedAt > before.updatedAt, "only the claim's lease marker (updatedAt) moved");
  assert.deepEqual({ ...after, status: before.status, failureReason: before.failureReason, updatedAt: before.updatedAt, failedCount: before.failedCount }, before, "no other column changed (time, other counts, body, startedAt, cancelledAt)");
  assert.deepEqual([after.failedCount, after.recipientCount], [2, 2], "the failed count follows the settled recipients");
  assertCountsMatch(f.campaignId);
  assert.equal(((await transitionEmailCampaignStatus(f.campaignId, "SCHEDULED", { db: D(), now: NOW, scheduledAt: FUTURE })) as any).reason, "invalid_transition", "FAILED stays final");
});

test("TRANSITIONS: the internal close is conditional: a campaign cancelled in the meantime is never overwritten with FAILED, and its recipients are untouched", async () => {
  const f = await due({ textBody: "no link at all", htmlBody: null });
  const recipientsBefore = recipientsOf(f.campaignId);
  cancelBeforeClose(f);
  await sweep();
  delete (db as any).$transaction;
  assert.deepEqual([camp(f.campaignId).status, camp(f.campaignId).failureReason], ["CANCELLED", null]);
  assert.deepEqual(recipientsOf(f.campaignId), recipientsBefore, "not one recipient was written");
  assert.equal(jobs().length, 0);
});

// ================================================================================================================ permanent SCHEDULED refusals settle their recipients (P12 lifecycle correction)

/** Campaign counts must equal the final recipient rows, and a terminal campaign must have no PENDING recipient. */
function assertCountsMatch(id: string) {
  const c = camp(id);
  const rs = recipientsOf(id);
  const n = (st: string) => rs.filter((r) => r.status === st).length;
  assert.deepEqual([c.recipientCount, c.sentCount, c.failedCount, c.skippedCount], [rs.length, n("SENT"), n("FAILED"), n("SKIPPED")], "campaign counts match the recipient statuses");
  if (c.status === "FAILED") assert.equal(n("PENDING"), 0, "a FAILED campaign keeps no PENDING recipient");
}
/** Simulates another request (a cancel) that commits just BEFORE the close transaction starts; under PostgreSQL the row lock orders them the same way. */
function cancelBeforeClose(f: Fixture) {
  const real = (db as any).$transaction.bind(db);
  (db as any).$transaction = async (arg: any) => { db.patch("emailCampaign", f.campaignId, { status: "CANCELLED", cancelledAt: NOW }); return real(arg); };
}
const snapshotOf = (id: string) => JSON.stringify([camp(id), recipientsOf(id)]);

test("CLOSE / invalid snapshot: the campaign fails, every PENDING recipient is settled FAILED(invalid_message), no PENDING row remains, no job exists", async () => {
  const f = await due({}, E(3));
  db.patch("emailCampaign", f.campaignId, { subject: "" });
  assert.deepEqual(summaryOf(await sweep()), [1, 0, 0, 0, 1, false]);
  const c = camp(f.campaignId);
  assert.deepEqual([c.status, c.failureReason], ["FAILED", "invalid_snapshot"]);
  assert.deepEqual(byStatus(f), { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 3, SKIPPED: 0 });
  assert.ok(recipientsOf(f.campaignId).every((r) => r.errorCode === "invalid_message" && !r.emailJobId && !r.queuedAt));
  assertCountsMatch(f.campaignId);
  assert.equal(jobs().length, 0);
  assert.deepEqual(summaryOf(await sweep({ now: IDLE_AGAIN })), [0, 0, 0, 0, 0, false], "a closed campaign is never picked again");
});

test("CLOSE / missing unsubscribe link: the campaign fails, every PENDING recipient is settled FAILED(unsubscribe_link_missing), no PENDING row remains", async () => {
  const f = await due({ textBody: "no link at all", htmlBody: null }, E(4));
  await sweep();
  assert.deepEqual([camp(f.campaignId).status, camp(f.campaignId).failureReason], ["FAILED", "unsubscribe_link_missing"]);
  assert.deepEqual(byStatus(f), { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 4, SKIPPED: 0 });
  assert.ok(recipientsOf(f.campaignId).every((r) => r.errorCode === "unsubscribe_link_missing"));
  assertCountsMatch(f.campaignId);
  assert.equal(jobs().length, 0);
});

test("CLOSE / no_recipients: the existing no-audience handling is kept (FAILED, nothing queued), counts follow the rows, and a stranded PENDING row is settled too", async () => {
  const gone = await due({}, E(2), new Date(T1.getTime() - 60_000));
  db.remove("emailCampaignRecipient", (r) => r.campaignId === gone.campaignId);
  const stranded = await due({}, E(2));
  db.patch("emailCampaign", stranded.campaignId, { recipientCount: 0 }); // the stored number says "no audience" although rows exist
  await sweep({ limit: 10 });
  assert.deepEqual([camp(gone.campaignId).status, camp(gone.campaignId).failureReason, camp(gone.campaignId).recipientCount], ["FAILED", "no_recipients", 0]);
  assert.deepEqual([camp(stranded.campaignId).status, camp(stranded.campaignId).failureReason], ["FAILED", "no_recipients"]);
  assert.deepEqual(byStatus(stranded), { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 2, SKIPPED: 0 });
  assert.ok(recipientsOf(stranded.campaignId).every((r) => r.errorCode === "campaign_closed"));
  assertCountsMatch(gone.campaignId); assertCountsMatch(stranded.campaignId);
  assert.equal(jobs().length, 0);
});

test("CLOSE: settled recipients, unrelated queued jobs and dedupe keys are untouched; only the PENDING rows change; counts include the earlier settled rows", async () => {
  await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["GP-9002"], to: "buyer@example.com", subject: "Your order", text: "Thanks" }, { db: D(), now: NOW, kick: false });
  const f = await due({ textBody: "no link at all", htmlBody: null }, E(5));
  const [sent, skipped, failed] = recipientsOf(f.campaignId);
  db.patch("emailCampaignRecipient", sent.id, { status: "SENT", sentAt: T0 });
  db.patch("emailCampaignRecipient", skipped.id, { status: "SKIPPED", skipReason: "suppressed" });
  db.patch("emailCampaignRecipient", failed.id, { status: "FAILED", errorCode: "attempts_exhausted" });
  const settledBefore = [sent.id, skipped.id, failed.id].map((id) => recipientsOf(f.campaignId).find((r) => r.id === id));
  const jobsBefore = jobs();
  const keysBefore = jobsBefore.map((j) => j.dedupeKey);
  await sweep();
  assert.deepEqual([sent.id, skipped.id, failed.id].map((id) => recipientsOf(f.campaignId).find((r) => r.id === id)), settledBefore, "already settled rows are byte-for-byte unchanged");
  assert.deepEqual(byStatus(f), { PENDING: 0, QUEUED: 0, SENT: 1, FAILED: 3, SKIPPED: 1 });
  assert.deepEqual(jobs(), jobsBefore, "no job was created, changed or removed");
  assert.deepEqual(jobs().map((j) => j.dedupeKey), keysBefore);
  assertCountsMatch(f.campaignId);
  assert.deepEqual([camp(f.campaignId).sentCount, camp(f.campaignId).failedCount, camp(f.campaignId).skippedCount], [1, 3, 1]);
});

test("CLOSE / concurrent status change (cancel) before the close leaves the campaign and ALL recipients untouched, for every permanent refusal", async () => {
  for (const mk of [
    () => due({ textBody: "no link at all", htmlBody: null }, E(3)),
    async () => { const f = await due({}, E(3)); db.patch("emailCampaign", f.campaignId, { subject: "" }); return f; },
    async () => { const f = await due({}, E(3)); db.patch("emailCampaign", f.campaignId, { recipientCount: 0 }); return f; },
    async () => { const f = await due({}, E(3)); for (const e of E(3)) await suppressEmail(e, { reason: "ADMIN" }, { db: D(), now: NOW }); return f; },
  ]) {
    db = freshDb(); discardAfter();
    const f = await mk();
    const recipientsBefore = recipientsOf(f.campaignId);
    cancelBeforeClose(f);
    await sweep();
    delete (db as any).$transaction;
    assert.deepEqual([camp(f.campaignId).status, camp(f.campaignId).failureReason], ["CANCELLED", null]);
    assert.deepEqual(recipientsOf(f.campaignId), recipientsBefore, "recipients untouched");
    assert.equal(jobs().length, 0);
  }
});

test("CLOSE / a database error during the close rolls everything back: the campaign stays SCHEDULED and every recipient stays PENDING; the next run closes it", async () => {
  const f = await due({ textBody: "no link at all", htmlBody: null }, E(3));
  const before = snapshotOf(f.campaignId);
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => { const d = orig(t); if (t === "emailCampaign") { const um = d.updateMany.bind(d); d.updateMany = async (a: any) => { if (a?.data?.status === "FAILED") throw new Error("connection reset"); return um(a); }; } return d; };
  const s = await sweep();
  delete (db as any).delegate;
  assert.deepEqual(summaryOf(s), [1, 0, 0, 0, 1, false], "counted once, not twice");
  assert.equal(camp(f.campaignId).status, "SCHEDULED");
  assert.deepEqual(byStatus(f), { PENDING: 3, QUEUED: 0, SENT: 0, FAILED: 0, SKIPPED: 0 }, "the recipient settle was rolled back with it");
  assert.deepEqual(recipientsOf(f.campaignId).map((r) => [r.status, r.errorCode]), JSON.parse(before)[1].map((r: any) => [r.status, r.errorCode]));
  await sweep({ now: at(1000) });
  assert.deepEqual([camp(f.campaignId).status, byStatus(f).PENDING], ["FAILED", 0]);
  assertCountsMatch(f.campaignId);
});

/** Four contacts, none of which can receive marketing mail now, each for a different real reason. */
async function ineligibleAudience() {
  const f = await due({}, ["supp@example.com", "unsub@example.com", "inactive@example.com", "noconsent@example.com"]);
  await suppressEmail("supp@example.com", { reason: "BOUNCED" }, { db: D(), now: NOW });
  await withdrawMarketingConsent(f.contacts["unsub@example.com"].contact.id, "ADMIN", { db: D(), now: NOW });
  await (db as any).emailContact.update({ where: { id: f.contacts["inactive@example.com"].contact.id }, data: { isActive: false } });
  db.remove("marketingConsent", (c) => c.contactId === f.contacts["noconsent@example.com"].contact.id);
  return f;
}
const rowOf = (f: Fixture, email: string) => recipientsOf(f.campaignId).find((r) => r.contactId === f.contacts[email].contact.id)!;
/** The eligibility check cannot be answered for `email` (a failing query), as in a database blip. */
function breakEligibilityFor(email: string | null) {
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => { const d = orig(t); if (t === "emailSuppression") { const ff = d.findFirst.bind(d); d.findFirst = async (a: any) => { if (email === null || a?.where?.email === email) throw new Error("db down"); return ff(a); }; } return d; };
}

test("CLOSE / no_eligible_recipients: a fully, verifiably ineligible audience is SKIPPED with each recipient's ACTUAL reason and the campaign is closed as FAILED", async () => {
  const f = await ineligibleAudience();
  const jobsBefore = jobs();
  assert.deepEqual(summaryOf(await sweep()), [1, 0, 0, 0, 1, false]);
  assert.deepEqual([camp(f.campaignId).status, camp(f.campaignId).failureReason], ["FAILED", "no_eligible_recipients"]);
  const reasons = Object.fromEntries(["supp", "unsub", "inactive", "noconsent"].map((n) => [n, [rowOf(f, `${n}@example.com`).status, rowOf(f, `${n}@example.com`).skipReason]]));
  assert.deepEqual(reasons, { supp: ["SKIPPED", "suppressed"], unsub: ["SKIPPED", "no_consent"], inactive: ["SKIPPED", "inactive"], noconsent: ["SKIPPED", "no_consent"] }, "each recipient has its own actual reason, not one generic code");
  assert.deepEqual(byStatus(f), { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 0, SKIPPED: 4 });
  assert.ok(recipientsOf(f.campaignId).every((r) => !r.emailJobId && !r.errorCode));
  assertCountsMatch(f.campaignId);
  assert.equal(camp(f.campaignId).skippedCount, 4);
  assert.deepEqual(jobs(), jobsBefore);
  assert.deepEqual(summaryOf(await sweep({ now: IDLE_AGAIN })), [0, 0, 0, 0, 0, false]);
});

test("CLOSE / no_eligible_recipients: an UNVERIFIABLE eligibility result never fails the campaign: it stays SCHEDULED, no recipient is modified (not even the verifiably ineligible ones), and it closes or sends once checks work", async () => {
  const f = await ineligibleAudience();
  breakEligibilityFor("inactive@example.com"); // one answer cannot be verified, the other three are verifiably ineligible
  const campaignBefore = camp(f.campaignId);
  const recipientsBefore = recipientsOf(f.campaignId);
  const s = await sweep();
  delete (db as any).delegate;
  assert.deepEqual(summaryOf(s), [1, 0, 0, 0, 1, false]);
  assert.equal(camp(f.campaignId).status, "SCHEDULED");
  assert.equal(camp(f.campaignId).failureReason, null);
  assert.deepEqual({ ...camp(f.campaignId), updatedAt: null }, { ...campaignBefore, updatedAt: null }, "the campaign row is unchanged apart from the claim's lease marker");
  assert.deepEqual(byStatus(f), { PENDING: 4, QUEUED: 0, SENT: 0, FAILED: 0, SKIPPED: 0 });
  assert.deepEqual(recipientsOf(f.campaignId), recipientsBefore, "recipients untouched");
  assert.equal(jobs().length, 0);
  // Retryable: the very next run, with checks working again, reaches the real verdict.
  assert.deepEqual(summaryOf(await sweep({ now: at(1000) })), [1, 0, 0, 0, 1, false]);
  assert.deepEqual([camp(f.campaignId).status, byStatus(f).SKIPPED, byStatus(f).PENDING], ["FAILED", 4, 0]);
  assertCountsMatch(f.campaignId);
});

test("CLOSE / no_eligible_recipients: when EVERY check fails (a database outage) the whole audience stays PENDING and the campaign stays SCHEDULED, run after run", async () => {
  const f = await due({}, E(3));
  breakEligibilityFor(null);
  const before = JSON.stringify(recipientsOf(f.campaignId));
  for (const now of [NOW, at(1000), at(2000)]) { const s = await sweep({ now }); assert.deepEqual([s.dispatched, s.failed], [0, 1]); }
  delete (db as any).delegate;
  assert.equal(camp(f.campaignId).status, "SCHEDULED");
  assert.equal(JSON.stringify(recipientsOf(f.campaignId)), before);
  assert.equal(jobs().length, 0);
  assert.deepEqual(summaryOf(await sweep({ now: at(3000) })), [1, 1, 0, 0, 0, false], "healthy again: it is simply sent");
  assert.equal(jobs().length, 3);
});

test("CLOSE / no_eligible_recipients: a recipient who BECOMES eligible during the re-evaluation is not settled: nothing is written, and that recipient is dispatched next run", async () => {
  const f = await due({}, ["one@example.com", "two@example.com", "three@example.com"]);
  for (const e of ["one@example.com", "two@example.com", "three@example.com"]) await withdrawMarketingConsent(f.contacts[e].contact.id, "ADMIN", { db: D(), now: NOW });
  // dispatch (outside the close transaction) finds nobody; then "two" re-consents before the close transaction runs.
  const real = (db as any).$transaction.bind(db);
  (db as any).$transaction = async (arg: any) => {
    const c = f.contacts["two@example.com"].consent;
    db.patch("marketingConsent", c.id, { unsubscribedAt: null });
    return real(arg);
  };
  const s = await sweep();
  delete (db as any).$transaction;
  assert.deepEqual(summaryOf(s), [1, 0, 0, 0, 1, false]);
  assert.equal(camp(f.campaignId).status, "SCHEDULED");
  assert.deepEqual(byStatus(f), { PENDING: 3, QUEUED: 0, SENT: 0, FAILED: 0, SKIPPED: 0 }, "no recipient (not even the two still ineligible) was settled");
  assert.equal(jobs().length, 0);
  // next run: the eligible one gets its job, the others are skipped by the normal dispatch path
  assert.deepEqual(summaryOf(await sweep({ now: at(1000) })), [1, 1, 0, 0, 0, false]);
  assert.deepEqual([rowOf(f, "two@example.com").status, rowOf(f, "one@example.com").status, rowOf(f, "three@example.com").status], ["QUEUED", "SKIPPED", "SKIPPED"]);
  assert.equal(jobs().length, 1);
});

test("CLOSE / no_eligible_recipients: a recipient settled earlier survives unchanged while the PENDING ones are judged", async () => {
  const f = await ineligibleAudience();
  const first = recipientsOf(f.campaignId)[0];
  db.patch("emailCampaignRecipient", first.id, { status: "SKIPPED", skipReason: "suppressed" }); // settled earlier: must survive unchanged
  const settledBefore = JSON.stringify(recipientsOf(f.campaignId).find((r) => r.id === first.id));
  await sweep();
  assert.equal(JSON.stringify(recipientsOf(f.campaignId).find((r) => r.id === first.id)), settledBefore);
  assert.equal(camp(f.campaignId).status, "FAILED");
  assert.deepEqual(byStatus(f), { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 0, SKIPPED: 4 });
  assertCountsMatch(f.campaignId);
});

test("CLOSE: the close logs ids, codes and counts only (no address, content, link or secret)", async () => {
  await due({}, E(2));
  await due({ textBody: "secret body text", htmlBody: null }, E(2));
  for (const e of E(2)) await suppressEmail(e, { reason: "ADMIN" }, { db: D(), now: NOW }); // both campaigns are prepared first, then the audience becomes ineligible
  await sweep({ limit: 10 });
  const text = logs.lines.join("\n");
  assert.match(text, /closed|close_deferred/);
  assert.doesNotMatch(text, /@example\.com|api\/email\/unsubscribe|test-only-unsubscribe-secret|secret body|Campaign \d/);
});

// ================================================================================================================ permanently failing SENDING campaigns

/** A SENDING campaign that was interrupted after its first chunk: `queued` recipients have jobs, the rest are still PENDING. */
async function interrupted(n = 5, chunkSize = 2) {
  const f = await due({}, E(n));
  const orig = (db as any).delegate.bind(db);
  let calls = 0;
  (db as any).delegate = (t: string) => { const d = orig(t); if (t === "emailJob") { const cm = d.createMany.bind(d); d.createMany = async (a: any) => { calls++; if (calls === 2) throw new Error("disk full"); return cm(a); }; } return d; };
  const first = await sweep({ chunkSize });
  delete (db as any).delegate;
  assert.equal(first.failed, 1);
  assert.equal(camp(f.campaignId).status, "SENDING");
  return f;
}
const STALE = at(CAMPAIGN_RESUME_STALE_MS + 1000);
const IDLE_AGAIN = at(2 * CAMPAIGN_RESUME_STALE_MS + 2000);
const byStatus = (f: Fixture) => Object.fromEntries(["PENDING", "QUEUED", "SENT", "FAILED", "SKIPPED"].map((st) => [st, recipientsOf(f.campaignId).filter((r) => r.status === st).length]));

test("SENDING / permanent: a resume whose snapshot has lost its unsubscribe link settles ONLY the PENDING recipients as FAILED; queued ones, their jobs and the campaign are untouched, and the retry loop ends", async () => {
  const f = await interrupted(6);
  const queuedRows = recipientsOf(f.campaignId).filter((r) => r.status === "QUEUED");
  const skipped = recipientsOf(f.campaignId).filter((r) => r.status === "PENDING")[0];
  db.patch("emailCampaignRecipient", skipped.id, { status: "SKIPPED", skipReason: "unsubscribed" });
  const jobsBefore = jobs();
  assert.deepEqual(byStatus(f), { PENDING: 3, QUEUED: 2, SENT: 0, FAILED: 0, SKIPPED: 1 });
  db.patch("emailCampaign", f.campaignId, { textBody: "the link was lost", htmlBody: null }); // content frozen after DRAFT: this is a pre-P12 or damaged campaign

  const s = await sweep({ now: STALE, chunkSize: 2 });
  assert.deepEqual(summaryOf(s), [1, 0, 0, 0, 1, false]);
  assert.deepEqual(byStatus(f), { PENDING: 0, QUEUED: 2, SENT: 0, FAILED: 3, SKIPPED: 1 });
  assert.ok(recipientsOf(f.campaignId).filter((r) => r.status === "FAILED").every((r) => r.errorCode === "unsubscribe_link_missing" && !r.emailJobId));
  assert.deepEqual(recipientsOf(f.campaignId).filter((r) => r.status === "QUEUED").map((r) => [r.id, r.emailJobId]), queuedRows.map((r) => [r.id, r.emailJobId]), "queued recipients keep their jobs");
  assert.deepEqual(jobs(), jobsBefore, "not one job was touched, added or removed");
  assert.equal(camp(f.campaignId).status, "SENDING", "NOT marked FAILED: that would block the queued jobs at the delivery gate");
  assert.deepEqual([camp(f.campaignId).failedCount, camp(f.campaignId).skippedCount], [3, 1], "counts refreshed by the existing reconcile");

  assert.deepEqual(summaryOf(await sweep({ now: IDLE_AGAIN })), [0, 0, 0, 0, 0, false], "nothing PENDING: no longer a resume candidate, no endless retry");

  const w = await processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: IDLE_AGAIN });
  assert.equal(w.sent, 2, "the queued recipients are still delivered, with their links");
  assert.ok(smtp.mails.every((m: any) => m.headers["List-Unsubscribe"]));
  assert.deepEqual([camp(f.campaignId).status, camp(f.campaignId).sentCount, camp(f.campaignId).failedCount, camp(f.campaignId).skippedCount], ["COMPLETED", 2, 3, 1]);
  assert.equal(jobs().length, 2);
});

test("SENDING / permanent: an invalid snapshot is settled the same way, with the invalid_message code", async () => {
  const f = await interrupted(5);
  db.patch("emailCampaign", f.campaignId, { subject: "" });
  assert.deepEqual(summaryOf(await sweep({ now: STALE, chunkSize: 2 })), [1, 0, 0, 0, 1, false]);
  assert.deepEqual(byStatus(f), { PENDING: 0, QUEUED: 2, SENT: 0, FAILED: 3, SKIPPED: 0 });
  assert.ok(recipientsOf(f.campaignId).filter((r) => r.status === "FAILED").every((r) => r.errorCode === "invalid_message"));
  assert.equal(camp(f.campaignId).status, "SENDING");
  assert.equal(jobs().length, 2);
  assert.deepEqual(summaryOf(await sweep({ now: IDLE_AGAIN })), [0, 0, 0, 0, 0, false]);
});

test("SENDING / permanent: with nothing queued at all, the existing reconcile completes the campaign (failed counts kept); no job exists and none is created", async () => {
  const f = await due({}, E(3));
  db.patch("emailCampaign", f.campaignId, { status: "SENDING", startedAt: T0, textBody: "no link", htmlBody: null });
  assert.deepEqual(summaryOf(await sweep({ now: STALE })), [1, 0, 0, 0, 1, false]);
  assert.deepEqual(byStatus(f), { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 3, SKIPPED: 0 });
  assert.equal(jobs().length, 0);
  const c = camp(f.campaignId);
  assert.deepEqual([c.status, c.failedCount, c.sentCount, c.completedAt instanceof Date], ["COMPLETED", 3, 0, true]);
  assert.deepEqual(summaryOf(await sweep({ now: IDLE_AGAIN })), [0, 0, 0, 0, 0, false]);
});

test("SENDING / permanent: a campaign cancelled before the settle is left alone (its PENDING recipients are not rewritten)", async () => {
  const f = await interrupted(5);
  db.patch("emailCampaign", f.campaignId, { textBody: "no link", htmlBody: null });
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailCampaign") { const um = d.updateMany.bind(d); d.updateMany = async (a: any) => { if (a?.where?.status === "SENDING" && !("updatedAt" in a.where)) db.patch("emailCampaign", f.campaignId, { status: "CANCELLED", cancelledAt: STALE }); return um(a); }; }
    return d;
  };
  await sweep({ now: STALE, chunkSize: 2 });
  delete (db as any).delegate;
  assert.equal(camp(f.campaignId).status, "CANCELLED");
  assert.deepEqual(byStatus(f), { PENDING: 3, QUEUED: 2, SENT: 0, FAILED: 0, SKIPPED: 0 });
});

test("SENDING / transient: a missing unsubscribe configuration leaves the campaign resumable (PENDING untouched), is retried only once per idle window, and completes when configuration is back, without duplicates", async () => {
  const f = await interrupted(5);
  const queuedIds = jobs().map((j) => j.id).sort();
  assert.deepEqual(summaryOf(await sweep({ now: STALE, chunkSize: 2, unsubscribeEnv: {} })), [1, 0, 0, 0, 1, false]);
  assert.deepEqual(byStatus(f), { PENDING: 3, QUEUED: 2, SENT: 0, FAILED: 0, SKIPPED: 0 }, "nothing was failed");
  assert.equal(camp(f.campaignId).status, "SENDING");
  assert.deepEqual(summaryOf(await sweep({ now: STALE, chunkSize: 2, unsubscribeEnv: {} })), [0, 0, 0, 0, 0, false], "not retried again inside the same idle window");
  assert.deepEqual(summaryOf(await sweep({ now: IDLE_AGAIN, chunkSize: 2, unsubscribeEnv: {} })), [1, 0, 0, 0, 1, false], "retried after the next idle window");
  assert.deepEqual(byStatus(f), { PENDING: 3, QUEUED: 2, SENT: 0, FAILED: 0, SKIPPED: 0 });
  assert.deepEqual(summaryOf(await sweep({ now: at(3 * CAMPAIGN_RESUME_STALE_MS + 3000), chunkSize: 2 })), [1, 1, 1, 0, 0, false]);
  assert.equal(jobs().length, 5);
  assert.ok(queuedIds.every((id) => jobs().some((j) => j.id === id)));
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 5);
});

test("SENDING / transient: an interrupted resume (a database error) stays resumable: nothing is failed, and the next idle window finishes it exactly once", async () => {
  const f = await interrupted(5);
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => { const d = orig(t); if (t === "emailJob") { const cm = d.createMany.bind(d); d.createMany = async () => { throw new Error("connection reset"); }; void cm; } return d; };
  assert.deepEqual(summaryOf(await sweep({ now: STALE, chunkSize: 2 })), [1, 0, 0, 0, 1, false]);
  delete (db as any).delegate;
  assert.deepEqual(byStatus(f), { PENDING: 3, QUEUED: 2, SENT: 0, FAILED: 0, SKIPPED: 0 });
  assert.equal(camp(f.campaignId).status, "SENDING");
  assert.deepEqual(summaryOf(await sweep({ now: IDLE_AGAIN, chunkSize: 2 })), [1, 1, 1, 0, 0, false]);
  assert.equal(jobs().length, 5);
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 5);
  assert.ok(recipientsOf(f.campaignId).every((r) => r.status === "QUEUED"));
});

test("SENDING / permanent: the settle logs ids, codes and counts only", async () => {
  const f = await interrupted(4);
  db.patch("emailCampaign", f.campaignId, { textBody: "no link", htmlBody: null });
  await sweep({ now: STALE, chunkSize: 2 });
  const text = logs.lines.join("\n");
  assert.match(text, /settled_pending|settled as failed/);
  assert.doesNotMatch(text, /@example\.com|api\/email\/unsubscribe|test-only-unsubscribe-secret|no link/);
});

// ================================================================================================================ the cron route

const SECRET = "c".repeat(32);
const url = "http://localhost/api/email/campaigns/dispatch";
async function dueForRoute() {
  const f = await due({}, E(2));
  db.patch("emailCampaign", f.campaignId, { scheduledAt: new Date("2000-01-01T00:00:00Z"), updatedAt: new Date("2000-01-01T00:00:00Z") }); // due whatever the clock says
  return f;
}

test("CRON: refused without credentials, with wrong credentials, and when no CRON_SECRET is configured; nothing is dispatched", async () => {
  const f = await dueForRoute();
  const saved = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = SECRET;
    assert.equal((await POST(new Request(url, { method: "POST" }))).status, 401, "missing");
    assert.equal((await GET(new Request(url))).status, 401, "missing (GET)");
    for (const header of ["Bearer wrong", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`, SECRET, `Basic ${SECRET}`, "Bearer", "Bearer "]) {
      assert.equal((await POST(new Request(url, { method: "POST", headers: { authorization: header } }))).status, 401, header);
    }
    delete process.env.CRON_SECRET;
    assert.equal((await POST(new Request(url, { method: "POST", headers: { authorization: "Bearer " } }))).status, 401, "no secret configured = disabled");
    assert.equal((await POST(new Request(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }))).status, 401, "still disabled");
    const res = await POST(new Request(url, { method: "POST" }));
    assert.deepEqual(await res.json(), { ok: false }, "the refusal says nothing");
  } finally { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
  assert.deepEqual([camp(f.campaignId).status, jobs().length], ["SCHEDULED", 0], "no refused request dispatched anything");
});

test("CRON: the valid secret runs the dispatcher (GET and POST) and the response is counts only, with no campaign or recipient data", async () => {
  const saved = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = SECRET;
    const f = await dueForRoute();
    const res = await POST(new Request(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, processed: 1, dispatched: 1, resumed: 0, skipped: 0, failed: 0, hasMore: false });
    assert.equal(camp(f.campaignId).status, "SENDING");
    assert.equal(jobs().length, 2);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /@|Campaign|Hello|unsubscribe|token|secret/i);
    for (const j of jobs()) assert.ok(!text.includes(j.id));
    const again = await GET(new Request(url, { headers: { authorization: `Bearer ${SECRET}` } }));
    assert.deepEqual(await again.json(), { ok: true, processed: 0, dispatched: 0, resumed: 0, skipped: 0, failed: 0, hasMore: false }, "a repeated request does nothing");
    assert.equal(jobs().length, 2);
  } finally { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
});

test("CRON: an internal failure never leaks its message; the response is still counts only", async () => {
  const saved = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = SECRET;
    const orig = (db as any).delegate.bind(db);
    (db as any).delegate = (t: string) => { const d = orig(t); if (t === "emailCampaign") d.findMany = async () => { throw new Error("db password=hunter2 user1@example.com"); }; return d; };
    const res = await POST(new Request(url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    delete (db as any).delegate;
    const text = JSON.stringify(await res.json());
    assert.doesNotMatch(text, /hunter2|@|password/);
    assert.doesNotMatch(logs.lines.join("\n"), /hunter2|user1@example/);
  } finally { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
});
