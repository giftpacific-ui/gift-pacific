/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE tests for the PostgreSQL behaviour that campaign dispatch and the worker rely on (Prompt 10). They run only when TEST_DATABASE_URL
 * points at a disposable PostgreSQL database with ALL migrations applied and the `pg` driver installed (it is not an app dependency). Otherwise they
 * are SKIPPED, which is NOT the same as passing.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/giftpacific_test pnpm test
 *
 * Scope, stated honestly: the project's test setup replaces @prisma/client with a stub, so the TypeScript services are NOT run against a real Prisma
 * client here. These tests exercise the same SQL-level guarantees the services depend on (unique keys, ON CONFLICT DO NOTHING, conditional updates,
 * row-lock serialisation, CHECK constraints, FK behaviour, transaction rollback) with raw SQL and several real connections. The in-memory
 * database used elsewhere serialises transactions and so cannot prove any of the locking claims. Every row uses a unique run prefix and is removed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set - real-database tests skipped";
const run = `p10${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const id = (n: string) => `${run}_${n}`;

const clients: any[] = [];
async function connect(): Promise<any> {
  const { Client } = await import("pg" as string);
  const c = new Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
}
let main: any;
const q = async (text: string, params: unknown[] = []) => (main ??= await connect()).query(text, params);
async function fails(code: string, text: string, params: unknown[] = []) {
  await assert.rejects(q(text, params), (e: any) => { assert.equal(e.code, code, e.message); return true; });
}

const addContact = (n: string) => q(`INSERT INTO "EmailContact" (id, email, source, "updatedAt") VALUES ($1, $2, 'MANUAL', now())`, [id(n), `${id(n)}@example.com`]);
const addCampaign = (n: string, status = "DRAFT", extra = "") =>
  q(`INSERT INTO "EmailCampaign" (id, name, subject, "textBody", status${extra ? ', "scheduledAt"' : ""}, "updatedAt") VALUES ($1, $1, 's', 't', $2${extra ? ", now() + interval '1 hour'" : ""}, now())`, [id(n), status]);
const addJob = (n: string, key = id(`key_${n}`)) => q(`INSERT INTO "EmailJob" (id, kind, "dedupeKey", priority, "toEmail", subject, text, "updatedAt") VALUES ($1, 'campaign', $2, 1, 'x@example.com', 's', 't', now())`, [id(n), key]);
const addRecipient = (n: string, campaign: string, contact: string, extra = "") =>
  q(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", "updatedAt"${extra ? ", " + extra.split("|")[0] : ""}) VALUES ($1, $2, $3, now()${extra ? ", " + extra.split("|")[1] : ""})`, [id(n), id(campaign), id(contact)]);

after(async () => {
  if (!clients.length) return;
  const like = `${run}%`;
  for (const sql of [`DELETE FROM "EmailCampaignRecipient" WHERE id LIKE $1`, `DELETE FROM "EmailCampaign" WHERE id LIKE $1`, `DELETE FROM "EmailJob" WHERE id LIKE $1`, `DELETE FROM "EmailContact" WHERE id LIKE $1`]) {
    await clients[0].query(sql, [like]).catch(() => {});
  }
  await Promise.all(clients.map((c) => c.end()));
});

test("EmailJob.dedupeKey is unique: concurrent ON CONFLICT DO NOTHING inserts from separate connections create exactly one job (what enqueueEmails relies on)", { skip }, async () => {
  const conns = await Promise.all(Array.from({ length: 6 }, () => connect()));
  const key = id("dupkey");
  const results = await Promise.all(conns.map((c, i) => c.query(`INSERT INTO "EmailJob" (id, kind, "dedupeKey", priority, "toEmail", subject, text, "updatedAt") VALUES ($1, 'campaign', $2, 1, 'x@example.com', 's', 't', now()) ON CONFLICT ("dedupeKey") DO NOTHING`, [id(`dj${i}`), key])));
  assert.equal(results.reduce((n, r) => n + r.rowCount, 0), 1);
  assert.equal((await q(`SELECT count(*)::int AS n FROM "EmailJob" WHERE "dedupeKey" = $1`, [key])).rows[0].n, 1);
});

test("one EmailJob can serve only one recipient (unique emailJobId); unlinked recipients (NULL) never collide", { skip }, async () => {
  await addCampaign("c1");
  for (const n of ["k1", "k2", "k3"]) await addContact(n);
  await addJob("j1");
  await addRecipient("r1", "c1", "k1", `"emailJobId"|'${id("j1")}'`);
  await fails("23505", `INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", "emailJobId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [id("r2"), id("c1"), id("k2"), id("j1")]);
  await addRecipient("r3", "c1", "k2");
  await addRecipient("r4", "c1", "k3");
  assert.equal((await q(`SELECT count(*)::int AS n FROM "EmailCampaignRecipient" WHERE "campaignId" = $1 AND "emailJobId" IS NULL`, [id("c1")])).rows[0].n, 2);
});

test("creating the job and linking its recipient in ONE transaction is atomic: a rollback leaves neither (the chunk failure case)", { skip }, async () => {
  await addCampaign("c2");
  await addContact("k4");
  await addRecipient("r5", "c2", "k4");
  const c = await connect();
  await c.query("BEGIN");
  await c.query(`INSERT INTO "EmailJob" (id, kind, "dedupeKey", priority, "toEmail", subject, text, "updatedAt") VALUES ($1, 'campaign', $2, 1, 'x@example.com', 's', 't', now())`, [id("j2"), id("key_j2")]);
  await c.query(`UPDATE "EmailCampaignRecipient" SET status = 'QUEUED', "emailJobId" = $1, "queuedAt" = now() WHERE id = $2 AND status = 'PENDING'`, [id("j2"), id("r5")]);
  await c.query("ROLLBACK");
  assert.equal((await q(`SELECT count(*)::int AS n FROM "EmailJob" WHERE id = $1`, [id("j2")])).rows[0].n, 0, "no orphan job");
  const r = (await q(`SELECT status, "emailJobId" FROM "EmailCampaignRecipient" WHERE id = $1`, [id("r5")])).rows[0];
  assert.deepEqual([r.status, r.emailJobId], ["PENDING", null], "the recipient is still PENDING, so a resume redoes it");
});

test("deleting a job (retention) leaves its recipient with a NULL link (ON DELETE SET NULL): the case reconcile marks job_missing", { skip }, async () => {
  await addCampaign("c3");
  await addContact("k5");
  await addJob("j3");
  await addRecipient("r6", "c3", "k5", `"emailJobId", status|'${id("j3")}', 'QUEUED'`);
  await q(`DELETE FROM "EmailJob" WHERE id = $1`, [id("j3")]);
  const r = (await q(`SELECT status, "emailJobId" FROM "EmailCampaignRecipient" WHERE id = $1`, [id("r6")])).rows[0];
  assert.deepEqual([r.status, r.emailJobId], ["QUEUED", null]);
});

test("recipient status CHECK: SKIPPED needs a skip reason, any other status must not have one; FAILED with an error code is allowed", { skip }, async () => {
  await addCampaign("c4");
  for (const n of ["k6", "k7", "k8"]) await addContact(n);
  await fails("23514", `INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", status, "updatedAt") VALUES ($1, $2, $3, 'SKIPPED', now())`, [id("r7"), id("c4"), id("k6")]);
  await fails("23514", `INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", status, "skipReason", "updatedAt") VALUES ($1, $2, $3, 'QUEUED', 'suppressed', now())`, [id("r8"), id("c4"), id("k6")]);
  await q(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", status, "skipReason", "updatedAt") VALUES ($1, $2, $3, 'SKIPPED', 'suppressed', now())`, [id("r9"), id("c4"), id("k6")]);
  await q(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", status, "errorCode", "updatedAt") VALUES ($1, $2, $3, 'FAILED', 'campaign_not_active', now())`, [id("r10"), id("c4"), id("k7")]);
  // the worker's conditional move QUEUED -> SKIPPED sets both columns in one statement, so it always satisfies the CHECK
  await q(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", status, "updatedAt") VALUES ($1, $2, $3, 'QUEUED', now())`, [id("r11"), id("c4"), id("k8")]);
  const res = await q(`UPDATE "EmailCampaignRecipient" SET status = 'SKIPPED', "skipReason" = 'suppressed' WHERE id = $1 AND status = 'QUEUED'`, [id("r11")]);
  assert.equal(res.rowCount, 1);
});

test("only ONE of several concurrent requests can start a SCHEDULED campaign (the conditional SCHEDULED -> SENDING update)", { skip }, async () => {
  await addCampaign("c5", "SCHEDULED", "x");
  const conns = await Promise.all(Array.from({ length: 6 }, () => connect()));
  const results = await Promise.all(conns.map((c) => c.query(`UPDATE "EmailCampaign" SET status = 'SENDING', "startedAt" = now() WHERE id = $1 AND status = 'SCHEDULED'`, [id("c5")])));
  assert.equal(results.reduce((n, r) => n + r.rowCount, 0), 1);
  assert.equal((await q(`SELECT status FROM "EmailCampaign" WHERE id = $1`, [id("c5")])).rows[0].status, "SENDING");
});

test("the per-chunk campaign guard serialises concurrent dispatches and sees a cancel: a waiting guard re-checks the status after the other transaction commits", { skip }, async () => {
  await addCampaign("c6", "SENDING");
  const [a, b] = await Promise.all([connect(), connect()]);
  const guard = `UPDATE "EmailCampaign" SET "updatedAt" = now() WHERE id = $1 AND status = 'SENDING'`;
  await a.query("BEGIN");
  assert.equal((await a.query(guard, [id("c6")])).rowCount, 1);
  await b.query("BEGIN");
  let bDone = false;
  const bGuard = b.query(guard, [id("c6")]).then((r: any) => { bDone = true; return r; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bDone, false, "the second dispatch chunk waits on the row lock while the first holds it");
  await a.query(`UPDATE "EmailCampaign" SET status = 'CANCELLED', "cancelledAt" = now() WHERE id = $1`, [id("c6")]);
  await a.query("COMMIT");
  const res = await bGuard;
  assert.equal(res.rowCount, 0, "after the cancel commits, the waiting guard no longer matches: the dispatch stops");
  await b.query("ROLLBACK");
});

test("two workers cannot claim the same job (the queue's conditional PENDING -> PROCESSING update)", { skip }, async () => {
  await addJob("j4");
  const conns = await Promise.all(Array.from({ length: 5 }, () => connect()));
  const results = await Promise.all(conns.map((c) => c.query(`UPDATE "EmailJob" SET status = 'PROCESSING', attempts = attempts + 1, "lockedAt" = now() WHERE id = $1 AND status = 'PENDING' AND attempts < 5`, [id("j4")])));
  assert.equal(results.reduce((n, r) => n + r.rowCount, 0), 1);
});

test("campaign count and completion CHECKs behind the reconcile step", { skip }, async () => {
  await addCampaign("c7", "SENDING");
  await fails("23514", `UPDATE "EmailCampaign" SET "recipientCount" = 2, "sentCount" = 2, "failedCount" = 1 WHERE id = $1`, [id("c7")]);
  await q(`UPDATE "EmailCampaign" SET "recipientCount" = 3, "sentCount" = 1, "failedCount" = 1, "skippedCount" = 1 WHERE id = $1`, [id("c7")]);
  await fails("23514", `UPDATE "EmailCampaign" SET status = 'COMPLETED' WHERE id = $1`, [id("c7")]);
  await q(`UPDATE "EmailCampaign" SET status = 'COMPLETED', "completedAt" = now() WHERE id = $1 AND status = 'SENDING'`, [id("c7")]);
  assert.equal((await q(`SELECT status FROM "EmailCampaign" WHERE id = $1`, [id("c7")])).rows[0].status, "COMPLETED");
});
