/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE tests for the PostgreSQL behaviour that the due-campaign dispatcher relies on (Prompt 12). They run only when TEST_DATABASE_URL points
 * at a disposable PostgreSQL database with ALL migrations applied and the `pg` driver installed (it is not an app dependency). Otherwise they are
 * SKIPPED, which is NOT the same as passing.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/giftpacific_test pnpm test
 *
 * Scope, stated honestly: the project's test setup replaces @prisma/client with a stub, so the TypeScript service is NOT run against a real Prisma
 * client here. These tests exercise, with raw SQL and several real connections, the same statements the service issues: the compare-and-set claim, the
 * due / resumable selection (including the EXISTS on PENDING recipients) and the conditional close to FAILED under the table's CHECK constraints.
 * The in-memory database serialises transactions and so cannot prove any of the concurrency claims. Every row uses a unique run prefix and is removed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set - real-database tests skipped";
const run = `p12${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

/** `when`: SQL for scheduledAt (null = none); `idle`: SQL interval the row has been untouched for. */
const addCampaign = (n: string, status: string, when: string | null, idle = "0 seconds") =>
  q(`INSERT INTO "EmailCampaign" (id, name, subject, "textBody", status, "scheduledAt", "updatedAt") VALUES ($1, $1, 's', 't {{unsubscribeUrl}}', $2, ${when ?? "NULL"}, now() - interval '${idle}')`, [id(n), status]);
const addContact = (n: string) => q(`INSERT INTO "EmailContact" (id, email, source, "updatedAt") VALUES ($1, $2, 'MANUAL', now())`, [id(n), `${id(n)}@example.com`]);
const addRecipient = (n: string, campaign: string, contact: string, status = "PENDING") =>
  q(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", status, "updatedAt") VALUES ($1, $2, $3, $4, now())`, [id(n), id(campaign), id(contact), status]);

after(async () => {
  if (!clients.length) return;
  const like = `${run}%`;
  for (const sql of [`DELETE FROM "EmailCampaignRecipient" WHERE id LIKE $1`, `DELETE FROM "EmailCampaign" WHERE id LIKE $1`, `DELETE FROM "EmailContact" WHERE id LIKE $1`]) {
    await clients[0].query(sql, [like]).catch(() => {});
  }
  await Promise.all(clients.map((c) => c.end()));
});

// The exact shape of the service's claim: compare-and-set on the updatedAt value that was read, writing a strictly larger one.
const CLAIM = `UPDATE "EmailCampaign" SET "updatedAt" = GREATEST($3::timestamp, "updatedAt" + interval '1 millisecond') WHERE id = $1 AND status = $2 AND "updatedAt" = $4::timestamp`;

test("CLAIM: concurrent compare-and-set claims from separate connections: exactly one wins, whoever races (what stops two crons dispatching one campaign)", { skip }, async () => {
  await addCampaign("claim", "SCHEDULED", "now() - interval '1 hour'", "1 hour");
  const seen = (await q(`SELECT "updatedAt"::text AS u, (now() at time zone 'utc')::text AS n FROM "EmailCampaign" WHERE id = $1`, [id("claim")])).rows[0];
  const conns = await Promise.all(Array.from({ length: 8 }, () => connect()));
  const results = await Promise.all(conns.map((c) => c.query(CLAIM, [id("claim"), "SCHEDULED", seen.n, seen.u])));
  assert.equal(results.reduce((n: number, r: any) => n + r.rowCount, 0), 1, "exactly one claim succeeded");
  const after = (await q(`SELECT "updatedAt" > $2::timestamp AS moved FROM "EmailCampaign" WHERE id = $1`, [id("claim"), seen.u])).rows[0];
  assert.equal(after.moved, true, "the winner's updatedAt is strictly larger, so a stale reader can never match again");
  assert.equal((await q(CLAIM, [id("claim"), "SCHEDULED", seen.n, seen.u])).rowCount, 0, "a later caller holding the old value matches nothing");
});

test("CLAIM: a claim only matches the status that was read (a campaign that started or was cancelled meanwhile is not claimed)", { skip }, async () => {
  await addCampaign("claimstatus", "CANCELLED", "now() - interval '1 hour'", "1 hour");
  const seen = (await q(`SELECT "updatedAt"::text AS u, (now() at time zone 'utc')::text AS n FROM "EmailCampaign" WHERE id = $1`, [id("claimstatus")])).rows[0];
  assert.equal((await q(CLAIM, [id("claimstatus"), "SCHEDULED", seen.n, seen.u])).rowCount, 0);
  assert.equal((await q(`SELECT status FROM "EmailCampaign" WHERE id = $1`, [id("claimstatus")])).rows[0].status, "CANCELLED");
});

test("SELECTION: due = SCHEDULED with scheduledAt <= now (inclusive), oldest first; DRAFT, CANCELLED, COMPLETED, FAILED, SENDING and future campaigns are never candidates", { skip }, async () => {
  await addCampaign("d_old", "SCHEDULED", "now() - interval '3 hours'");
  await addCampaign("d_new", "SCHEDULED", "now() - interval '1 hour'");
  await addCampaign("d_future", "SCHEDULED", "now() + interval '1 hour'");
  for (const s of ["DRAFT", "CANCELLED", "COMPLETED", "FAILED", "SENDING"]) await addCampaign(`d_${s}`, s, "now() - interval '2 hours'");
  const rows = (await q(`SELECT id FROM "EmailCampaign" WHERE id LIKE $1 AND status = 'SCHEDULED' AND "scheduledAt" <= now() ORDER BY "scheduledAt" ASC, id ASC LIMIT 11`, [`${run}_d_%`])).rows.map((r: any) => r.id);
  assert.deepEqual(rows, [id("d_old"), id("d_new")]);
});

test("SELECTION: resumable = SENDING, idle past the threshold, with at least one PENDING recipient; a SENDING campaign that is active or fully queued is not a candidate", { skip }, async () => {
  await addContact("c1");
  await addCampaign("r_stale_pending", "SENDING", null, "10 minutes");
  await addRecipient("rp1", "r_stale_pending", "c1", "PENDING");
  await addCampaign("r_stale_queued", "SENDING", null, "10 minutes");
  await addRecipient("rp2", "r_stale_queued", "c1", "QUEUED");
  await addCampaign("r_active_pending", "SENDING", null, "10 seconds");
  await addRecipient("rp3", "r_active_pending", "c1", "PENDING");
  await addCampaign("r_stale_sched", "SCHEDULED", "now() + interval '1 day'", "10 minutes");
  await addRecipient("rp4", "r_stale_sched", "c1", "PENDING");
  const rows = (await q(
    `SELECT c.id FROM "EmailCampaign" c WHERE c.id LIKE $1 AND c.status = 'SENDING' AND c."updatedAt" < now() - interval '5 minutes'
       AND EXISTS (SELECT 1 FROM "EmailCampaignRecipient" r WHERE r."campaignId" = c.id AND r.status = 'PENDING') ORDER BY c."updatedAt" ASC, c.id ASC LIMIT 11`, [`${run}_r_%`])).rows.map((r: any) => r.id);
  assert.deepEqual(rows, [id("r_stale_pending")]);
});

test("CLOSE: a campaign that cannot be sent is closed SCHEDULED -> FAILED with its code, conditionally, under the table's CHECK constraints; a changed status is never overwritten", { skip }, async () => {
  await addCampaign("close", "SCHEDULED", "now() - interval '1 hour'");
  const CLOSE = `UPDATE "EmailCampaign" SET status = 'FAILED', "failureReason" = $2 WHERE id = $1 AND status = 'SCHEDULED'`;
  const conns = await Promise.all(Array.from({ length: 4 }, () => connect()));
  const results = await Promise.all(conns.map((c) => c.query(CLOSE, [id("close"), "unsubscribe_link_missing"])));
  assert.equal(results.reduce((n: number, r: any) => n + r.rowCount, 0), 1, "closed once");
  const row = (await q(`SELECT status, "failureReason" FROM "EmailCampaign" WHERE id = $1`, [id("close")])).rows[0];
  assert.deepEqual([row.status, row.failureReason], ["FAILED", "unsubscribe_link_missing"]);

  await addCampaign("close_cancelled", "CANCELLED", "now() - interval '1 hour'");
  assert.equal((await q(CLOSE, [id("close_cancelled"), "no_recipients"])).rowCount, 0, "a cancelled campaign is not overwritten");
  assert.equal((await q(`SELECT status FROM "EmailCampaign" WHERE id = $1`, [id("close_cancelled")])).rows[0].status, "CANCELLED");
});

test("SETTLE (SENDING, permanent): the guarded transaction fails ONLY the PENDING recipients, leaves QUEUED / SKIPPED untouched under the CHECK constraints, and does nothing for a campaign that is no longer SENDING", { skip }, async () => {
  for (const n of ["s1", "s2", "s3", "s4"]) await addContact(n);
  await addCampaign("settle", "SENDING", null, "10 minutes");
  await addRecipient("sr1", "settle", "s1", "PENDING");
  await addRecipient("sr2", "settle", "s2", "QUEUED");
  await q(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", status, "skipReason", "updatedAt") VALUES ($1, $2, $3, 'SKIPPED', 'unsubscribed', now())`, [id("sr3"), id("settle"), id("s3")]);
  const c = await connect();
  const settle = async (campaign: string) => {
    await c.query("BEGIN");
    try {
      const guard = await c.query(`UPDATE "EmailCampaign" SET "updatedAt" = now() WHERE id = $1 AND status = 'SENDING'`, [id(campaign)]);
      const n = guard.rowCount === 0 ? 0 : (await c.query(`UPDATE "EmailCampaignRecipient" SET status = 'FAILED', "errorCode" = $2 WHERE "campaignId" = $1 AND status = 'PENDING'`, [id(campaign), "unsubscribe_link_missing"])).rowCount;
      await c.query("COMMIT");
      return n;
    } catch (e) { await c.query("ROLLBACK"); throw e; }
  };
  assert.equal(await settle("settle"), 1);
  const rows = (await q(`SELECT id, status, "errorCode", "skipReason" FROM "EmailCampaignRecipient" WHERE "campaignId" = $1 ORDER BY id`, [id("settle")])).rows;
  assert.deepEqual(rows.map((r: any) => [r.status, r.errorCode, r.skipReason]), [["FAILED", "unsubscribe_link_missing", null], ["QUEUED", null, null], ["SKIPPED", null, "unsubscribed"]]);
  assert.equal(await settle("settle"), 0, "nothing PENDING any more: repeating it changes nothing");

  await addCampaign("settle_cancelled", "CANCELLED", null, "10 minutes");
  await addRecipient("sr4", "settle_cancelled", "s4", "PENDING");
  assert.equal(await settle("settle_cancelled"), 0);
  assert.equal((await q(`SELECT status FROM "EmailCampaignRecipient" WHERE id = $1`, [id("sr4")])).rows[0].status, "PENDING", "a cancelled campaign's recipients are not rewritten");
});
