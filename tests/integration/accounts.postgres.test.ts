/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE tests for account linking (skipped unless TEST_DATABASE_URL points at a disposable
 * PostgreSQL with ALL migrations applied and the `pg` driver installed). They have NOT been run yet.
 *  - one provider identity can belong to only ONE user, even under parallel link attempts;
 *  - the unlink guard (lock the user row, count methods, delete) never strands an account when two
 *    unlink requests race: exactly one succeeds.
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
const addUser = (c: any, id: string, hash: string | null) =>
  c.query(`INSERT INTO "User" (id,name,email,"passwordHash","updatedAt") VALUES ($1,'U',$1||'@x.test',$2,now())`, [id, hash]);

test("one provider identity cannot be linked to two users under parallel attempts", { skip }, async () => {
  const setup = await connect();
  const users = Array.from({ length: 10 }, (_, i) => uid(`lu${i}`));
  const identity = uid("g");
  for (const u of users) await addUser(setup, u, "h");
  const clients = await Promise.all(users.map(connect));
  try {
    const results = await Promise.all(clients.map(async (c: any, i: number) => {
      try { await c.query(`INSERT INTO "OAuthAccount" (id,"userId",provider,"providerAccountId") VALUES ($1,$2,'GOOGLE',$3)`, [uid("oa"), users[i], identity]); return "ok"; }
      catch (e: any) { return e.code; }
    }));
    assert.equal(results.filter((r) => r === "ok").length, 1);
    assert.equal(results.filter((r) => r === "23505").length, 9);
  } finally {
    for (const u of users) await setup.query(`DELETE FROM "User" WHERE id=$1`, [u]);
    await Promise.all([setup, ...clients].map((c) => c.end()));
  }
});

test("racing unlinks of a social-only user's two providers: exactly one wins, one method always remains", { skip }, async () => {
  const setup = await connect();
  const user = uid("ul");
  await addUser(setup, user, null);
  await setup.query(`INSERT INTO "OAuthAccount" (id,"userId",provider,"providerAccountId") VALUES ($1,$2,'GOOGLE',$3),($4,$2,'FACEBOOK',$5)`, [uid("a"), user, uid("g"), uid("b"), uid("f")]);
  const [c1, c2] = await Promise.all([connect(), connect()]);
  // Same statement sequence the service runs: lock via UPDATE, count, delete only if another method remains.
  const unlink = async (c: any, provider: string) => {
    await c.query("BEGIN");
    try {
      await c.query(`UPDATE "User" SET "updatedAt" = now() WHERE id = $1`, [user]);
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM "OAuthAccount" WHERE "userId" = $1`, [user]);
      if (rows[0].n < 2) { await c.query("ROLLBACK"); return "refused"; }
      await c.query(`DELETE FROM "OAuthAccount" WHERE "userId" = $1 AND provider = $2`, [user, provider]);
      await c.query("COMMIT");
      return "ok";
    } catch (e) { await c.query("ROLLBACK"); throw e; }
  };
  try {
    const results = await Promise.all([unlink(c1, "GOOGLE"), unlink(c2, "FACEBOOK")]);
    assert.deepEqual([...results].sort(), ["ok", "refused"]);
    const left = await setup.query(`SELECT count(*)::int AS n FROM "OAuthAccount" WHERE "userId" = $1`, [user]);
    assert.equal(left.rows[0].n, 1);
  } finally {
    await setup.query(`DELETE FROM "User" WHERE id=$1`, [user]);
    await Promise.all([setup, c1, c2].map((c) => c.end()));
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Phase 1 (accounting): third-party order money. NOT RUN — needs a disposable PostgreSQL with ALL migrations (incl. 20261109*) + `pg`.
// ---------------------------------------------------------------------------------------------------------------------------------
async function addMarketplaceOrder(c: any, total: number) {
  const channel = uid("ch"), order = uid("ord");
  await c.query(`INSERT INTO "SalesChannel" (id,key,name,kind) VALUES ($1,$1,'Test market','MARKETPLACE')`, [channel]);
  await c.query(
    `INSERT INTO "Order" (id,"orderNumber","confirmationToken",phone,"shippingSnapshot",subtotal,total,"channelId","updatedAt") VALUES ($1,$1,$1,'0','{}'::jsonb,$2,$2,$3,now())`,
    [order, total, channel],
  );
  return { channel, order };
}

test("a wallet transaction id can be recorded only once per method, even under parallel attempts (Payment unique index)", { skip }, async () => {
  const setup = await connect();
  const { channel, order } = await addMarketplaceOrder(setup, 1000);
  const ref = uid("TX").toUpperCase();
  const clients = await Promise.all(Array.from({ length: 6 }, connect));
  try {
    const results = await Promise.all(clients.map(async (c: any) => {
      try { await c.query(`INSERT INTO "Payment" (id,"orderId",method,status,amount,"providerRef",kind) VALUES ($1,$2,'BKASH','PAID',100,$3,'ADVANCE')`, [uid("p"), order, ref]); return "ok"; }
      catch (e: any) { return e.code; }
    }));
    assert.equal(results.filter((r) => r === "ok").length, 1);
    assert.equal(results.filter((r) => r === "23505").length, 5);
  } finally {
    await setup.query(`DELETE FROM "Order" WHERE id=$1`, [order]); await setup.query(`DELETE FROM "SalesChannel" WHERE id=$1`, [channel]);
    await Promise.all([setup, ...clients].map((c) => c.end()));
  }
});

test("racing marketplace payouts are serialised by the order-row lock: the total received never exceeds the expected payout", { skip }, async () => {
  const setup = await connect();
  const { channel, order } = await addMarketplaceOrder(setup, 1000);
  const [c1, c2] = await Promise.all([connect(), connect()]);
  // Same statement sequence recordSettlement() runs: lock via UPDATE, re-read the total received, insert only if it still fits.
  const record = async (c: any, amount: number, ref: string) => {
    await c.query("BEGIN");
    try {
      await c.query(`UPDATE "Order" SET "updatedAt" = now() WHERE id = $1`, [order]);
      const { rows } = await c.query(`SELECT COALESCE(SUM(amount),0)::numeric AS got FROM "MarketplaceSettlement" WHERE "orderId" = $1`, [order]);
      if (Number(rows[0].got) + amount > 1000) { await c.query("ROLLBACK"); return "refused"; }
      await c.query(`INSERT INTO "MarketplaceSettlement" (id,"orderId",amount,"receivedOn",reference) VALUES ($1,$2,$3,CURRENT_DATE,$4)`, [uid("s"), order, amount, ref]);
      await c.query("COMMIT");
      return "ok";
    } catch (e) { await c.query("ROLLBACK"); throw e; }
  };
  try {
    const results = await Promise.all([record(c1, 700, "A"), record(c2, 700, "B")]);
    assert.deepEqual([...results].sort(), ["ok", "refused"]);
    const { rows } = await setup.query(`SELECT SUM(amount)::numeric AS got FROM "MarketplaceSettlement" WHERE "orderId" = $1`, [order]);
    assert.equal(Number(rows[0].got), 700);
  } finally {
    await setup.query(`DELETE FROM "Order" WHERE id=$1`, [order]); await setup.query(`DELETE FROM "SalesChannel" WHERE id=$1`, [channel]);
    await Promise.all([setup, c1, c2].map((c) => c.end()));
  }
});

test("settlement table guards: payout must be > 0; the same (order, reference) and the same idempotency key cannot repeat", { skip }, async () => {
  const setup = await connect();
  const { channel, order } = await addMarketplaceOrder(setup, 1000);
  const ins = (amount: number, ref: string | null, key: string | null) =>
    setup.query(`INSERT INTO "MarketplaceSettlement" (id,"orderId",amount,"receivedOn",reference,"idempotencyKey") VALUES ($1,$2,$3,CURRENT_DATE,$4,$5)`, [uid("s"), order, amount, ref, key]);
  try {
    await assert.rejects(ins(0, "R0", null), (e: any) => e.code === "23514");
    await assert.rejects(ins(-5, "R1", null), (e: any) => e.code === "23514");
    await ins(100, "REF1", "KEY1");
    await assert.rejects(ins(50, "REF1", null), (e: any) => e.code === "23505");
    await assert.rejects(ins(50, "REF2", "KEY1"), (e: any) => e.code === "23505");
    await ins(10, null, null); await ins(10, null, null); // NULL references are distinct in PostgreSQL: the SERVICE guards this case (amount + date)
  } finally {
    await setup.query(`DELETE FROM "Order" WHERE id=$1`, [order]); await setup.query(`DELETE FROM "SalesChannel" WHERE id=$1`, [channel]);
    await setup.end();
  }
});
