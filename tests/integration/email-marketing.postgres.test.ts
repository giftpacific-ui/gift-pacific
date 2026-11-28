/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE tests for the Prompt 07 e-mail marketing tables. They run only when TEST_DATABASE_URL points at a disposable PostgreSQL database
 * that has ALL migrations applied (`prisma migrate deploy`) and the `pg` driver is installed (it is not an app dependency). Otherwise they are
 * SKIPPED, which is NOT the same as passing.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/giftpacific_test pnpm test
 *
 * What they prove that the in-memory fake cannot: the CHECK constraints, the partial unique index, the foreign keys' ON DELETE behaviour, and that
 * an EmailJob row written the old way is still valid. Every row uses a unique run prefix and is removed afterwards.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set - real-database tests skipped";
const run = `it${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const id = (n: string) => `${run}_${n}`;
const mail = (n: string) => `${run}_${n}@example.com`;

let client: any;
async function db(): Promise<any> {
  if (client) return client;
  const { Client } = await import("pg" as string);
  client = new Client({ connectionString: url });
  await client.connect();
  return client;
}
const q = async (text: string, params: unknown[] = []) => (await db()).query(text, params);
/** The statement must fail with this PostgreSQL error class: 23505 unique, 23514 check, 23503 foreign key. */
async function fails(code: string, text: string, params: unknown[] = []) {
  await assert.rejects(q(text, params), (e: any) => { assert.equal(e.code, code, `${e.message}`); return true; });
}

const addContact = (n: string) => q(`INSERT INTO "EmailContact" (id, email, source, "updatedAt") VALUES ($1, $2, 'MANUAL', now())`, [id(n), mail(n)]);
const addJob = (n: string) => q(`INSERT INTO "EmailJob" (id, kind, "dedupeKey", "toEmail", subject, text, "updatedAt") VALUES ($1, 'campaign', $2, $3, 's', 't', now())`, [id(n), id(`dk_${n}`), mail(n)]);
const addCampaign = (n: string) => q(`INSERT INTO "EmailCampaign" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $1, 's', 't', now())`, [id(n)]);

after(async () => {
  if (!client) return;
  const like = `${run}%`;
  for (const sql of [
    `DELETE FROM "RecoveryEmail" WHERE id LIKE $1`, `DELETE FROM "EmailCampaignRecipient" WHERE id LIKE $1`, `DELETE FROM "EmailCampaign" WHERE id LIKE $1`,
    `DELETE FROM "EmailTemplate" WHERE id LIKE $1`, `DELETE FROM "MarketingConsent" WHERE id LIKE $1`, `DELETE FROM "EmailSuppression" WHERE id LIKE $1`,
    `DELETE FROM "EmailContact" WHERE id LIKE $1`, `DELETE FROM "EmailJob" WHERE id LIKE $1`, `DELETE FROM "IncompleteCheckout" WHERE id LIKE $1`, `DELETE FROM "Cart" WHERE id LIKE $1`,
  ]) await client.query(sql, [like]).catch(() => {});
  await client.end();
});

test("contact e-mail: unique, and the database refuses a non-normalised address", { skip }, async () => {
  await addContact("c1");
  await fails("23505", `INSERT INTO "EmailContact" (id, email, source, "updatedAt") VALUES ($1, $2, 'MANUAL', now())`, [id("c1dup"), mail("c1")]);
  await fails("23514", `INSERT INTO "EmailContact" (id, email, source, "updatedAt") VALUES ($1, $2, 'MANUAL', now())`, [id("c1up"), mail("c1up").toUpperCase()]);
  await fails("23514", `INSERT INTO "EmailContact" (id, email, source, "updatedAt") VALUES ($1, $2, 'MANUAL', now())`, [id("c1sp"), ` ${mail("c1sp")}`]);
});

test("unsubscribe token: only a 64-character lower-case hex digest is accepted, and it is unique", { skip }, async () => {
  const hash = "a".repeat(64);
  await q(`INSERT INTO "EmailContact" (id, email, source, "unsubscribeTokenHash", "updatedAt") VALUES ($1, $2, 'MANUAL', $3, now())`, [id("t1"), mail("t1"), hash]);
  await fails("23505", `INSERT INTO "EmailContact" (id, email, source, "unsubscribeTokenHash", "updatedAt") VALUES ($1, $2, 'MANUAL', $3, now())`, [id("t2"), mail("t2"), hash]);
  await fails("23514", `INSERT INTO "EmailContact" (id, email, source, "unsubscribeTokenHash", "updatedAt") VALUES ($1, $2, 'MANUAL', $3, now())`, [id("t3"), mail("t3"), "plaintext-token-value"]);
});

test("consent: one OPEN consent per contact (partial unique), history rows allowed, unsubscribe fields consistent", { skip }, async () => {
  await addContact("k1");
  const add = (n: string) => q(`INSERT INTO "MarketingConsent" (id, "contactId", source, "grantedAt", "updatedAt") VALUES ($1, $2, 'ADMIN_RECORDED', '2026-11-01T00:00:00Z', now())`, [id(n), id("k1")]);
  await add("k1a");
  await fails("23505", `INSERT INTO "MarketingConsent" (id, "contactId", source, "updatedAt") VALUES ($1, $2, 'SIGNUP_FORM', now())`, [id("k1b"), id("k1")]);
  await q(`UPDATE "MarketingConsent" SET "unsubscribedAt" = '2026-11-02T00:00:00Z', "unsubscribeSource" = 'LINK' WHERE id = $1`, [id("k1a")]);
  await add("k1c"); // opting in again after unsubscribing is a new row
  const { rows } = await q(`SELECT count(*)::int AS n FROM "MarketingConsent" WHERE "contactId" = $1`, [id("k1")]);
  assert.equal(rows[0].n, 2);
  await fails("23514", `UPDATE "MarketingConsent" SET "unsubscribedAt" = now() WHERE id = $1`, [id("k1c")]); // a time without a source
  await fails("23514", `UPDATE "MarketingConsent" SET "unsubscribedAt" = '2020-01-01T00:00:00Z', "unsubscribeSource" = 'ADMIN' WHERE id = $1`, [id("k1c")]); // before the grant
});

test("suppression: unique per address, normalised, and it survives the contact (SET NULL)", { skip }, async () => {
  await addContact("s1");
  await q(`INSERT INTO "EmailSuppression" (id, email, reason, "contactId", "updatedAt") VALUES ($1, $2, 'BOUNCED', $3, now())`, [id("s1"), mail("s1"), id("s1")]);
  await fails("23505", `INSERT INTO "EmailSuppression" (id, email, reason, "updatedAt") VALUES ($1, $2, 'COMPLAINED', now())`, [id("s1b"), mail("s1")]);
  await fails("23514", `INSERT INTO "EmailSuppression" (id, email, reason, "updatedAt") VALUES ($1, $2, 'ADMIN', now())`, [id("s1c"), mail("s1c").toUpperCase()]);
  await q(`DELETE FROM "EmailContact" WHERE id = $1`, [id("s1")]);
  const { rows } = await q(`SELECT "contactId" FROM "EmailSuppression" WHERE id = $1`, [id("s1")]);
  assert.equal(rows.length, 1, "the suppression remains");
  assert.equal(rows[0].contactId, null);
});

test("campaign rules: SCHEDULED needs a time, counts add up, a draft may be empty but a sendable campaign may not", { skip }, async () => {
  await fails("23514", `INSERT INTO "EmailCampaign" (id, name, subject, "textBody", status, "updatedAt") VALUES ($1, 'n', 's', 't', 'SCHEDULED', now())`, [id("cp1")]);
  await q(`INSERT INTO "EmailCampaign" (id, name, subject, "textBody", status, "scheduledAt", "updatedAt") VALUES ($1, 'n', 's', 't', 'SCHEDULED', now(), now())`, [id("cp2")]);
  await q(`INSERT INTO "EmailCampaign" (id, name, subject, "textBody", "updatedAt") VALUES ($1, 'draft', '', '', now())`, [id("cp3")]);
  await fails("23514", `UPDATE "EmailCampaign" SET status = 'SENDING' WHERE id = $1`, [id("cp3")]); // empty subject/body can't leave DRAFT
  await fails("23514", `UPDATE "EmailCampaign" SET "recipientCount" = 1, "sentCount" = 2 WHERE id = $1`, [id("cp2")]);
  await fails("23514", `UPDATE "EmailCampaign" SET "failedCount" = -1 WHERE id = $1`, [id("cp2")]);
});

test("campaign recipient: unique per (campaign, contact); one EmailJob per recipient; SET NULL on job purge; RESTRICT keeps history", { skip }, async () => {
  await addCampaign("r1"); await addContact("r1"); await addContact("r2"); await addJob("r1");
  const add = (n: string, contact: string, job: string | null = null) => q(`INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", "emailJobId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [id(n), id("r1"), id(contact), job ? id(job) : null]);
  await add("rc1", "r1", "r1");
  await fails("23505", `INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", "updatedAt") VALUES ($1, $2, $3, now())`, [id("rc1dup"), id("r1"), id("r1")]);
  await fails("23505", `INSERT INTO "EmailCampaignRecipient" (id, "campaignId", "contactId", "emailJobId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [id("rc2"), id("r1"), id("r2"), id("r1")]);
  await fails("23514", `UPDATE "EmailCampaignRecipient" SET status = 'SKIPPED' WHERE id = $1`, [id("rc1")]); // skipped needs a reason
  await fails("23514", `UPDATE "EmailCampaignRecipient" SET "skipReason" = 'suppressed' WHERE id = $1`, [id("rc1")]); // a reason needs SKIPPED

  await q(`DELETE FROM "EmailJob" WHERE id = $1`, [id("r1")]); // what the queue's retention purge does
  const { rows } = await q(`SELECT "emailJobId" FROM "EmailCampaignRecipient" WHERE id = $1`, [id("rc1")]);
  assert.equal(rows.length, 1, "the send history survives the job purge");
  assert.equal(rows[0].emailJobId, null);

  await fails("23503", `DELETE FROM "EmailContact" WHERE id = $1`, [id("r1")]);
  await fails("23503", `DELETE FROM "EmailCampaign" WHERE id = $1`, [id("r1")]);
});

test("recovery e-mail: (eventKey, step) is unique, the key must match the kind, links clear (SET NULL) when the cart/checkout goes", { skip }, async () => {
  await addContact("v1");
  await q(`INSERT INTO "Cart" (id, "updatedAt") VALUES ($1, now())`, [id("cart1")]);
  await q(`INSERT INTO "IncompleteCheckout" (id, "ownerKey", items, "itemCount", subtotal, "estimatedTotal", "consentAt", "updatedAt") VALUES ($1, $2, '[]', 0, 0, 0, now(), now())`, [id("ic1"), `g:${id("ic1")}`]);
  const add = (n: string, kind: string, key: string, step: number, extra: Record<string, string | null> = {}) =>
    q(`INSERT INTO "RecoveryEmail" (id, kind, "eventKey", step, "contactId", "cartId", "incompleteCheckoutId", "updatedAt") VALUES ($1, $2::"RecoveryEmailKind", $3, $4, $5, $6, $7, now())`, [id(n), kind, key, step, id("v1"), extra.cartId ?? null, extra.icId ?? null]);

  await add("v1a", "INCOMPLETE_CHECKOUT", `ic:${id("ic1")}`, 1, { icId: id("ic1") });
  await fails("23505", `INSERT INTO "RecoveryEmail" (id, kind, "eventKey", step, "contactId", "updatedAt") VALUES ($1, 'INCOMPLETE_CHECKOUT', $2, 1, $3, now())`, [id("v1dup"), `ic:${id("ic1")}`, id("v1")]);
  await add("v1b", "INCOMPLETE_CHECKOUT", `ic:${id("ic1")}`, 2); // the second reminder of the same event
  await add("v1c", "ABANDONED_CART", `ac:${id("cart1")}:1763800000000`, 1, { cartId: id("cart1") });
  await add("v1d", "ABANDONED_CART", `ac:${id("cart1")}:1763900000000`, 1, { cartId: id("cart1") }); // the cart was used again: a new event
  await fails("23514", `INSERT INTO "RecoveryEmail" (id, kind, "eventKey", step, "contactId", "updatedAt") VALUES ($1, 'ABANDONED_CART', $2, 1, $3, now())`, [id("v1bad"), `ic:${id("ic1")}x`, id("v1")]);
  await fails("23514", `INSERT INTO "RecoveryEmail" (id, kind, "eventKey", step, "contactId", "updatedAt") VALUES ($1, 'INCOMPLETE_CHECKOUT', 'ic:x', 11, $2, now())`, [id("v1step"), id("v1")]);

  await q(`DELETE FROM "IncompleteCheckout" WHERE id = $1`, [id("ic1")]);
  await q(`DELETE FROM "Cart" WHERE id = $1`, [id("cart1")]);
  const { rows } = await q(`SELECT id, "cartId", "incompleteCheckoutId" FROM "RecoveryEmail" WHERE id LIKE $1`, [`${run}_v1%`]);
  assert.equal(rows.length, 4, "the reminders remain as history");
  assert.ok(rows.every((r: any) => r.cartId === null && r.incompleteCheckoutId === null));
  await fails("23503", `DELETE FROM "EmailContact" WHERE id = $1`, [id("v1")]);
});

test("EmailJob compatibility: a row written exactly as before Prompt 07 is still valid and needs no marketing record", { skip }, async () => {
  await q(`INSERT INTO "EmailJob" (id, kind, "dedupeKey", "toEmail", subject, text, "updatedAt") VALUES ($1, 'order-confirmation', $2, $3, 'Your order', 'Thanks', now())`, [id("legacy"), id("legacy_dk"), mail("legacy")]);
  const { rows } = await q(`SELECT status, priority, attempts, html FROM "EmailJob" WHERE id = $1`, [id("legacy")]);
  assert.deepEqual(rows[0], { status: "PENDING", priority: 0, attempts: 0, html: null });
  await fails("23505", `INSERT INTO "EmailJob" (id, kind, "dedupeKey", "toEmail", subject, text, "updatedAt") VALUES ($1, 'order-confirmation', $2, $3, 's', 't', now())`, [id("legacy2"), id("legacy_dk"), mail("legacy")]); // dedupeKey still unique
  const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'EmailJob' ORDER BY ordinal_position`);
  assert.deepEqual(cols.rows.map((r: any) => r.column_name), ["id", "kind", "dedupeKey", "priority", "toEmail", "subject", "text", "html", "status", "attempts", "nextAttemptAt", "lockedAt", "lastAttemptAt", "sentAt", "errorCode", "errorMessage", "messageId", "createdAt", "updatedAt"], "EmailJob's columns are unchanged");
});

test("template limits mirror the queue limits (a stored template can always be queued)", { skip }, async () => {
  await q(`INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $1, 's', 't', now())`, [id("tp1")]);
  await fails("23505", `INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $2, 's', 't', now())`, [id("tp2"), id("tp1")]);
  await fails("23514", `INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $1, $2, 't', now())`, [id("tp3"), "x".repeat(201)]);
  await fails("23514", `INSERT INTO "EmailTemplate" (id, name, subject, "textBody", "updatedAt") VALUES ($1, $1, 's', '', now())`, [id("tp4")]);
});
