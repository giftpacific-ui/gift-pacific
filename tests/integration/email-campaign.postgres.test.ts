/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE tests for the database behaviour Prompt 09's services rely on. They run only when TEST_DATABASE_URL points at a disposable
 * PostgreSQL database with ALL migrations applied (`prisma migrate deploy`) and the `pg` driver installed (it is not an app dependency). Otherwise
 * they are SKIPPED, which is NOT the same as passing.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/giftpacific_test pnpm test
 *
 * Scope, stated honestly: the project's test setup replaces @prisma/client with a stub, so these tests exercise the SAME SQL-level guarantees
 * (unique keys, CHECK constraints, ON CONFLICT DO NOTHING, advisory locks, FK behaviour) with raw SQL. They do not run the TypeScript services
 * against a real Prisma client. Every row uses a unique run prefix and is removed afterwards.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set - real-database tests skipped";
const run = `p9${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const id = (n: string) => `${run}_${n}`;
const mail = (n: string) => `${run}_${n}@example.com`;

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

const addTemplate = (n: string, name = id(n)) => q(`INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $2, 's', 't', now())`, [id(n), name]);
const addCampaign = (n: string) => q(`INSERT INTO "EmailCampaign" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $1, 's', 't', now())`, [id(n)]);
const addContact = (n: string) => q(`INSERT INTO "EmailContact" (id, email, source, "updatedAt") VALUES ($1, $2, 'MANUAL', now())`, [id(n), mail(n)]);

after(async () => {
  if (!clients.length) return;
  const like = `${run}%`;
  for (const sql of [`DELETE FROM "EmailCampaignRecipient" WHERE id LIKE $1 OR "campaignId" LIKE $1`, `DELETE FROM "EmailCampaign" WHERE id LIKE $1`, `DELETE FROM "EmailTemplate" WHERE id LIKE $1`, `DELETE FROM "MarketingConsent" WHERE id LIKE $1`, `DELETE FROM "EmailContact" WHERE id LIKE $1`]) {
    await clients[0].query(sql, [like]).catch(() => {});
  }
  await Promise.all(clients.map((c) => c.end()));
});

test("template name is unique (what createEmailTemplate / updateEmailTemplate map to duplicate_name), and the length CHECKs match the service limits", { skip }, async () => {
  await addTemplate("t1", id("same"));
  await fails("23505", `INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $2, 's', 't', now())`, [id("t1b"), id("same")]);
  const ins = (name: string, subject: string, body: string, html: string | null, n: string) =>
    q(`INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "htmlBody", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())`, [id(n), name, subject, body, html]);
  await ins(id("max"), "s".repeat(200), "b".repeat(100_000), "h".repeat(200_000), "tmax");
  await fails("23514", `INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $2, $3, 't', now())`, [id("t2"), id("n2"), "s".repeat(201)]);
  await fails("23514", `INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $2, 's', '', now())`, [id("t3"), id("n3")]);
  await fails("23514", `INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $2, 's', 't', now())`, [id("t4"), "n".repeat(121)]);
});

test("archiving a template (isActive=false) leaves the campaign reference intact; only a delete would clear it (SET NULL)", { skip }, async () => {
  await addTemplate("ta");
  await q(`INSERT INTO "EmailCampaign" (id, name, "templateId", subject, "textBody", "updatedAt") VALUES ($1, $1, $2, 's', 't', now())`, [id("ca"), id("ta")]);
  await q(`UPDATE "EmailTemplate" SET "isActive" = false WHERE id = $1`, [id("ta")]);
  assert.equal((await q(`SELECT "templateId" FROM "EmailCampaign" WHERE id = $1`, [id("ca")])).rows[0].templateId, id("ta"));
});

test("campaign CHECKs behind the status rules: SCHEDULED needs a time; counts stay consistent; a guarded status=DRAFT write matches nothing afterwards", { skip }, async () => {
  await addCampaign("cs");
  await fails("23514", `UPDATE "EmailCampaign" SET status = 'SCHEDULED' WHERE id = $1`, [id("cs")]);
  await q(`UPDATE "EmailCampaign" SET status = 'SCHEDULED', "scheduledAt" = now() + interval '1 day' WHERE id = $1`, [id("cs")]);
  await fails("23514", `UPDATE "EmailCampaign" SET "recipientCount" = 1, "skippedCount" = 2 WHERE id = $1`, [id("cs")]);
  // the guarded write the services use: it matches nothing once the status changed
  const res = await q(`UPDATE "EmailCampaign" SET description = 'x' WHERE id = $1 AND status = 'DRAFT'`, [id("cs")]);
  assert.equal(res.rowCount, 0);
});

test("recipient (campaignId, contactId) is unique, and ON CONFLICT DO NOTHING (createMany skipDuplicates) absorbs a repeat", { skip }, async () => {
  await addCampaign("cr");
  await addContact("k1");
  const insert = (n: string) => q(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", "updatedAt") VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`, [id(n), id("cr"), id("k1")]);
  assert.equal((await insert("r1")).rowCount, 1);
  assert.equal((await insert("r2")).rowCount, 0);
  await fails("23505", `INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", "updatedAt") VALUES ($1, $2, $3, now())`, [id("r3"), id("cr"), id("k1")]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM "EmailCampaignRecipient" WHERE "campaignId" = $1`, [id("cr")])).rows[0].n, 1);
});

test("concurrent inserts of the same recipient from separate connections create exactly one row", { skip }, async () => {
  await addCampaign("cc");
  await addContact("k2");
  const conns = await Promise.all(Array.from({ length: 6 }, () => connect()));
  const results = await Promise.all(conns.map((c, i) => c.query(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", "updatedAt") VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`, [id(`rc${i}`), id("cc"), id("k2")])));
  assert.equal(results.reduce((n, r) => n + r.rowCount, 0), 1);
  assert.equal((await q(`SELECT count(*)::int AS n FROM "EmailCampaignRecipient" WHERE "campaignId" = $1`, [id("cc")])).rows[0].n, 1);
});

test("a SKIPPED recipient must carry a skip reason and a PENDING one must not (the refresh step's rows)", { skip }, async () => {
  await addCampaign("cx");
  await addContact("k3");
  await q(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", "updatedAt") VALUES ($1, $2, $3, now())`, [id("rx"), id("cx"), id("k3")]);
  await fails("23514", `UPDATE "EmailCampaignRecipient" SET status = 'SKIPPED' WHERE id = $1`, [id("rx")]);
  await q(`UPDATE "EmailCampaignRecipient" SET status = 'SKIPPED', "skipReason" = 'suppressed' WHERE id = $1`, [id("rx")]);
  await fails("23514", `UPDATE "EmailCampaignRecipient" SET "skipReason" = NULL WHERE id = $1`, [id("rx")]);
});

test("the per-name advisory lock serialises two sessions (what keeps two racing campaign creates from both passing the duplicate check)", { skip }, async () => {
  const [a, b] = await Promise.all([connect(), connect()]);
  await a.query("BEGIN");
  await a.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`emailcampaign-name:${run}`]);
  await b.query("BEGIN");
  let bGotLock = false;
  const waiting = b.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`emailcampaign-name:${run}`]).then(() => { bGotLock = true; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bGotLock, false, "the second session waits while the first holds the lock");
  await a.query("COMMIT");
  await waiting;
  assert.equal(bGotLock, true);
  await b.query("COMMIT");
});
