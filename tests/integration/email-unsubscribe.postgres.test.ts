/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE tests for the PostgreSQL behaviour the stable unsubscribe design relies on (Prompt 11). Same rules as the P10 file next to it: they run
 * only when TEST_DATABASE_URL points at a disposable PostgreSQL database with ALL migrations applied and the `pg` driver installed; otherwise they are
 * SKIPPED, which is NOT the same as passing.
 *
 * Scope, stated honestly: @prisma/client is stubbed in this project's tests, so the TypeScript services are not run against a real Prisma client here.
 * These tests prove the SQL-level guarantees the services depend on, with raw SQL and real concurrent connections:
 *   - NO schema change was needed: the existing unsubscribeTokenHash column, its UNIQUE index and its 64-hex CHECK are exactly what the design uses;
 *   - a plaintext (43-character base64url) token cannot even be stored in that column;
 *   - one hash can belong to one contact only (so one token can never resolve to two contacts);
 *   - the unsubscribe writes are idempotent and race-safe: one UNSUBSCRIBED suppression per address (unique email), one open consent per contact.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set - real-database tests skipped";
const run = `p11${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
const SECRET = "test-only-unsubscribe-secret-Zq8Lm3Vx7Rb2Nc5Kd9Wp4Ty6";
const tokenFor = (contactId: string) => createHmac("sha256", SECRET).update(`giftpacific:email-unsubscribe:v1\n${contactId}`).digest("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const addContact = (n: string, hash: string | null = null) =>
  q(`INSERT INTO "EmailContact" (id, email, source, "unsubscribeTokenHash", "updatedAt") VALUES ($1, $2, 'MANUAL', $3, now())`, [id(n), `${id(n)}@example.com`, hash]);

after(async () => {
  if (!clients.length) return;
  const like = `${run}%`;
  for (const sql of [`DELETE FROM "EmailSuppression" WHERE email LIKE $1`, `DELETE FROM "MarketingConsent" WHERE "contactId" LIKE $1`, `DELETE FROM "EmailContact" WHERE id LIKE $1`]) await clients[0].query(sql, [like]).catch(() => {});
  await Promise.all(clients.map((c) => c.end()));
});

test("the existing column stores only the SHA-256 hash: a hash is accepted, a plaintext token and any other shape are refused by the CHECK", { skip }, async () => {
  const token = tokenFor(id("a"));
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  await addContact("a", sha(token));
  const row = (await q(`SELECT "unsubscribeTokenHash" FROM "EmailContact" WHERE id = $1`, [id("a")])).rows[0];
  assert.equal(row.unsubscribeTokenHash, sha(token));
  assert.notEqual(row.unsubscribeTokenHash, token);
  for (const [n, bad] of [["p1", token], ["p2", token.toUpperCase()], ["p3", sha(token).toUpperCase()], ["p4", sha(token).slice(1)], ["p5", ""]] as const) {
    await fails("23514", `INSERT INTO "EmailContact" (id, email, source, "unsubscribeTokenHash", "updatedAt") VALUES ($1, $2, 'MANUAL', $3, now())`, [id(n), `${id(n)}@example.com`, bad]);
  }
});

test("a token hash belongs to ONE contact: a second contact cannot hold it, so a token can never resolve to two contacts", { skip }, async () => {
  const h = sha(tokenFor(id("b1")));
  await addContact("b1", h);
  await fails("23505", `INSERT INTO "EmailContact" (id, email, source, "unsubscribeTokenHash", "updatedAt") VALUES ($1, $2, 'MANUAL', $3, now())`, [id("b2"), `${id("b2")}@example.com`, h]);
  await addContact("b3");
  await fails("23505", `UPDATE "EmailContact" SET "unsubscribeTokenHash" = $2 WHERE id = $1`, [id("b3"), h]);
  const hit = (await q(`SELECT id FROM "EmailContact" WHERE "unsubscribeTokenHash" = $1`, [h])).rows;
  assert.deepEqual(hit.map((r: any) => r.id), [id("b1")], "lookup by hash returns exactly the owner");
});

test("storing the stable hash is idempotent: writing the same value again changes nothing, and it is stable across campaigns", { skip }, async () => {
  await addContact("c1");
  const h = sha(tokenFor(id("c1")));
  for (let campaign = 0; campaign < 3; campaign++) {
    const r = await q(`UPDATE "EmailContact" SET "unsubscribeTokenHash" = $2 WHERE id = $1 RETURNING "unsubscribeTokenHash"`, [id("c1"), h]);
    assert.equal(r.rows[0].unsubscribeTokenHash, h);
  }
  assert.equal(sha(tokenFor(id("c1"))), h, "recomputing gives the same hash: nothing else is needed to find the contact again");
});

test("unsubscribe writes are race-safe: concurrent requests leave ONE suppression per address and ONE closed consent", { skip }, async () => {
  await addContact("d1");
  const email = `${id("d1")}@example.com`;
  await q(`INSERT INTO "MarketingConsent" (id, "contactId", source, "grantedAt", "updatedAt") VALUES ($1, $2, 'SIGNUP_FORM', now() - interval '1 day', now())`, [id("d1c"), id("d1")]);
  const conns = await Promise.all(Array.from({ length: 6 }, connect));
  await Promise.all(conns.map(async (c, i) => {
    await c.query("BEGIN");
    await c.query(`INSERT INTO "EmailSuppression" (id, email, reason, "contactId", "updatedAt") VALUES ($1, $2, 'UNSUBSCRIBED', $3, now()) ON CONFLICT (email) DO NOTHING`, [id(`d1s${i}`), email, id("d1")]);
    await c.query(`UPDATE "MarketingConsent" SET "unsubscribedAt" = now(), "unsubscribeSource" = 'LINK', "updatedAt" = now() WHERE "contactId" = $1 AND "unsubscribedAt" IS NULL`, [id("d1")]);
    await c.query("COMMIT");
  }));
  const sup = (await q(`SELECT reason FROM "EmailSuppression" WHERE email = $1`, [email])).rows;
  assert.deepEqual(sup.map((r: any) => r.reason), ["UNSUBSCRIBED"]);
  const consents = (await q(`SELECT "unsubscribeSource" FROM "MarketingConsent" WHERE "contactId" = $1`, [id("d1")])).rows;
  assert.deepEqual(consents.map((r: any) => r.unsubscribeSource), ["LINK"]);
});

test("a stronger suppression is not weakened: the conditional upsert the service uses leaves BOUNCED / COMPLAINED / ADMIN untouched", { skip }, async () => {
  for (const reason of ["BOUNCED", "COMPLAINED", "ADMIN"]) {
    const n = `e_${reason}`;
    await addContact(n);
    const email = `${id(n)}@example.com`;
    await q(`INSERT INTO "EmailSuppression" (id, email, reason, "contactId", "updatedAt") VALUES ($1, $2, $3::"EmailSuppressionReason", $4, now())`, [id(`${n}s`), email, reason, id(n)]);
    await q(`INSERT INTO "EmailSuppression" (id, email, reason, "contactId", "updatedAt") VALUES ($1, $2, 'UNSUBSCRIBED', $3, now()) ON CONFLICT (email) DO NOTHING`, [id(`${n}u`), email, id(n)]);
    assert.equal((await q(`SELECT reason FROM "EmailSuppression" WHERE email = $1`, [email])).rows[0].reason, reason);
  }
});
