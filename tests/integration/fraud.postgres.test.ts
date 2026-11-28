/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE tests for P4 (skipped unless TEST_DATABASE_URL points at a disposable PostgreSQL with ALL migrations applied, including
 * 20261124000000_fraud_p4, and the `pg` driver installed - see postgres.test.ts). They prove what the in-memory fake cannot:
 *  - the UNIQUE checkoutKey index lets exactly ONE of many truly parallel inserts win, so a double click can never create two orders;
 *  - NULL checkout keys (every order placed without one) never collide;
 *  - an order inserted the way pre-P4 code did gets riskReviewRequired = false (the migration is safe for existing rows);
 *  - the active-list query shape (not disabled, not expired) behaves as the app expects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set — real-database tests skipped";

async function connect(): Promise<any> {
  const { Client } = await import("pg" as string);
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}
const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const insertOrder = (c: any, id: string, checkoutKey: string | null) =>
  c.query(
    `INSERT INTO "Order" (id,"orderNumber","confirmationToken",phone,"shippingSnapshot",subtotal,total,"updatedAt","channelId","checkoutKey")
     VALUES ($1,$1,$1,'0','{}',1,1,now(),'channel_website',$2)`,
    [id, checkoutKey],
  );

test("parallel inserts with the SAME checkoutKey: exactly one order is created, the rest are refused by the unique index", { skip }, async () => {
  const key = uid("key");
  const clients = await Promise.all(Array.from({ length: 20 }, connect));
  try {
    const outcomes = await Promise.all(
      clients.map(async (c: any, i: number) => {
        try { await insertOrder(c, uid(`ord${i}`), key); return "created"; } catch (e: any) { return `error:${e.code}`; }
      }),
    );
    assert.equal(outcomes.filter((o) => o === "created").length, 1);
    assert.ok(outcomes.filter((o) => o !== "created").every((o) => o === "error:23505"), JSON.stringify(outcomes));
    const setup = await connect();
    const { rows } = await setup.query(`SELECT count(*)::int AS n FROM "Order" WHERE "checkoutKey" = $1`, [key]);
    await setup.query(`DELETE FROM "Order" WHERE "checkoutKey" = $1`, [key]);
    await setup.end();
    assert.equal(rows[0].n, 1);
  } finally { await Promise.all(clients.map((c: any) => c.end())); }
});

test("orders without a key (NULL) never collide, and an order inserted the pre-P4 way is valid with riskReviewRequired = false", { skip }, async () => {
  const c = await connect();
  const ids = [uid("n1"), uid("n2"), uid("n3")];
  try {
    for (const id of ids) await insertOrder(c, id, null);
    const { rows } = await c.query(`SELECT "riskReviewRequired", "riskScore", "riskLevel", "phoneNorm" FROM "Order" WHERE id = ANY($1)`, [ids]);
    assert.equal(rows.length, 3);
    for (const r of rows) assert.deepEqual([r.riskReviewRequired, r.riskScore, r.riskLevel, r.phoneNorm], [false, null, null, null]);
  } finally { await c.query(`DELETE FROM "Order" WHERE id = ANY($1)`, [ids]); await c.end(); }
});

test("active-list query shape: disabled and expired entries are ignored, a permanent entry matches", { skip }, async () => {
  const c = await connect();
  const v = `0171${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const ids: string[] = [];
  const add = async (extra: { expiresAt?: string | null; disabledAt?: string | null }) => {
    const id = uid("rl");
    ids.push(id);
    await c.query(
      `INSERT INTO "RiskListEntry" (id,"listType",kind,value,"displayValue",reason,"createdById","expiresAt","disabledAt") VALUES ($1,'BLOCK','PHONE',$2,$2,'test','a1',$3,$4)`,
      [id, v, extra.expiresAt ?? null, extra.disabledAt ?? null],
    );
  };
  const active = async () => (await c.query(`SELECT id FROM "RiskListEntry" WHERE kind='PHONE' AND value=$1 AND "disabledAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > now())`, [v])).rows.length;
  try {
    await add({ expiresAt: "2000-01-01T00:00:00Z" });
    await add({ disabledAt: "2020-01-01T00:00:00Z" });
    assert.equal(await active(), 0);
    await add({});
    assert.equal(await active(), 1);
  } finally { await c.query(`DELETE FROM "RiskListEntry" WHERE id = ANY($1)`, [ids]); await c.end(); }
});
