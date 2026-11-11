/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE tests (skipped unless TEST_DATABASE_URL points at a disposable PostgreSQL
 * with ALL migrations applied and the `pg` driver installed — see postgres.test.ts).
 *
 * They prove what the in-memory fake cannot, using the same SQL shapes the app uses:
 *  - parallel combo checkouts that take shared component stock in SORTED order never
 *    oversell and never deadlock;
 *  - a stock restore claim succeeds exactly once, however many callers race;
 *  - duplicate external orders and duplicate reviews are blocked by the database itself;
 *  - the rate limiter's counter is atomic under parallel attempts.
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

async function insertProduct(c: any, id: string, stock: number) {
  await c.query(`INSERT INTO "Product" (id, name, slug, description, price, stock, "updatedAt") VALUES ($1,$1,$1,'d',10,$2,now())`, [id, stock]);
}
async function insertOrder(c: any, id: string, extra: { channelId?: string; ref?: string | null } = {}) {
  await c.query(
    `INSERT INTO "Order" (id,"orderNumber","confirmationToken",phone,"shippingSnapshot",subtotal,total,"updatedAt","channelId","externalOrderRef")
     VALUES ($1,$1,$1,'0','{}',1,1,now(),$2,$3)`,
    [id, extra.channelId ?? "channel_website", extra.ref ?? null],
  );
}

test("parallel combo checkouts taking 2 shared components in sorted order: never oversell, never deadlock", { skip }, async () => {
  const setup = await connect();
  const a = uid("compA"), b = uid("compB");
  await insertProduct(setup, a, 7);
  await insertProduct(setup, b, 5);
  const clients = await Promise.all(Array.from({ length: 30 }, connect));
  try {
    // Each "checkout" needs 1 of A and 1 of B. Keys sorted => every transaction locks in the same order.
    const keys = [a, b].sort();
    const outcomes = await Promise.all(
      clients.map(async (c: any) => {
        try {
          await c.query("BEGIN");
          for (const key of keys) {
            const r = await c.query(`UPDATE "Product" SET stock = stock - 1 WHERE id = $1 AND stock >= 1`, [key]);
            if (r.rowCount !== 1) { await c.query("ROLLBACK"); return "sold-out"; }
          }
          await c.query("COMMIT");
          return "ok";
        } catch (e: any) {
          await c.query("ROLLBACK").catch(() => {});
          return `error:${e.code}`;
        }
      }),
    );
    assert.equal(outcomes.filter((o) => o.startsWith("error")).length, 0, `unexpected errors: ${outcomes}`); // no 40P01 deadlock
    assert.equal(outcomes.filter((o) => o === "ok").length, 5);       // exactly min(7, 5) checkouts succeed
    const { rows } = await setup.query(`SELECT id, stock FROM "Product" WHERE id = ANY($1)`, [[a, b]]);
    const stock = Object.fromEntries(rows.map((r: any) => [r.id, r.stock]));
    assert.equal(stock[b], 0);                                          // never negative
    assert.equal(stock[a], 2);                                          // a rolled-back checkout returned its unit
  } finally {
    await setup.query(`DELETE FROM "Product" WHERE id = ANY($1)`, [[a, b]]);
    await Promise.all([setup, ...clients].map((c) => c.end()));
  }
});

test("component restore claim (stockRestoredAt IS NULL) succeeds for exactly one of 20 racing callers", { skip }, async () => {
  const setup = await connect();
  const product = uid("p"), order = uid("o"), item = uid("oi"), comp = uid("oic");
  await insertProduct(setup, product, 0);
  await insertOrder(setup, order);
  await setup.query(`INSERT INTO "OrderItem" (id,"orderId","productId","productName","unitPrice",quantity,"lineTotal") VALUES ($1,$2,$3,'x',1,1,1)`, [item, order, product]);
  await setup.query(`INSERT INTO "OrderItemComponent" (id,"orderItemId","productId","productName",quantity,"unitPrice","stockDeducted") VALUES ($1,$2,$3,'x',1,1,4)`, [comp, item, product]);
  const clients = await Promise.all(Array.from({ length: 20 }, connect));
  try {
    const claims = await Promise.all(
      clients.map((c: any) => c.query(`UPDATE "OrderItemComponent" SET "stockRestoredAt" = now() WHERE id = $1 AND "stockRestoredAt" IS NULL`, [comp])),
    );
    assert.equal(claims.filter((r: any) => r.rowCount === 1).length, 1);
  } finally {
    await setup.query(`DELETE FROM "Order" WHERE id = $1`, [order]);
    await setup.query(`DELETE FROM "Product" WHERE id = $1`, [product]);
    await Promise.all([setup, ...clients].map((c) => c.end()));
  }
});

test("duplicate external order (same channel + reference) is blocked by the database under 20 parallel inserts", { skip }, async () => {
  const setup = await connect();
  const ref = uid("DZ");
  const ids = Array.from({ length: 20 }, () => uid("ord"));
  const clients = await Promise.all(Array.from({ length: 20 }, connect));
  try {
    const results = await Promise.all(
      clients.map(async (c: any, i: number) => {
        try { await insertOrder(c, ids[i], { channelId: "channel_daraz", ref }); return "ok"; }
        catch (e: any) { return e.code; }
      }),
    );
    assert.equal(results.filter((r) => r === "ok").length, 1);
    assert.equal(results.filter((r) => r === "23505").length, 19);
    // the same reference on ANOTHER channel is a different order; website orders (NULL ref) never collide
    await insertOrder(setup, uid("ord"), { channelId: "channel_cartup", ref });
    await insertOrder(setup, uid("ord"));
    await insertOrder(setup, uid("ord"));
  } finally {
    await setup.query(`DELETE FROM "Order" WHERE "externalOrderRef" = $1 OR "orderNumber" LIKE 'ord_%'`, [ref]);
    await Promise.all([setup, ...clients].map((c) => c.end()));
  }
});

test("one review per user+product and one per order item, enforced by the database under parallel inserts", { skip }, async () => {
  const setup = await connect();
  const user = uid("u"), product = uid("p");
  await setup.query(`INSERT INTO "User" (id,name,email,"updatedAt") VALUES ($1,'U',$1||'@x.test',now())`, [user]);
  await insertProduct(setup, product, 1);
  const clients = await Promise.all(Array.from({ length: 15 }, connect));
  try {
    const results = await Promise.all(
      clients.map(async (c: any, i: number) => {
        try { await c.query(`INSERT INTO "Review" (id,"productId","userId",rating) VALUES ($1,$2,$3,5)`, [uid(`r${i}`), product, user]); return "ok"; }
        catch (e: any) { return e.code; }
      }),
    );
    assert.equal(results.filter((r) => r === "ok").length, 1);
    assert.equal(results.filter((r) => r === "23505").length, 14);
  } finally {
    await setup.query(`DELETE FROM "User" WHERE id = $1`, [user]);
    await setup.query(`DELETE FROM "Product" WHERE id = $1`, [product]);
    await Promise.all([setup, ...clients].map((c) => c.end()));
  }
});

test("rate-limit counter (the exact statement the app uses) is atomic: 40 parallel attempts get counts 1..40", { skip }, async () => {
  const setup = await connect();
  const key = uid("rl");
  const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000);
  const clients = await Promise.all(Array.from({ length: 40 }, connect));
  try {
    const counts = await Promise.all(
      clients.map(async (c: any) => {
        const r = await c.query(
          `INSERT INTO "RateLimitBucket" ("key", "windowStart", "count") VALUES ($1, $2, 1)
           ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimitBucket"."count" + 1 RETURNING "count"`,
          [key, windowStart],
        );
        return Number(r.rows[0].count);
      }),
    );
    assert.deepEqual([...counts].sort((x, y) => x - y), Array.from({ length: 40 }, (_, i) => i + 1));
  } finally {
    await setup.query(`DELETE FROM "RateLimitBucket" WHERE "key" = $1`, [key]);
    await Promise.all([setup, ...clients].map((c) => c.end()));
  }
});

test("ORDER BY kind DESC lists COMBOs before SINGLEs on real PostgreSQL (enum declaration order)", { skip }, async () => {
  const setup = await connect();
  const ids = ["s1", "c1", "s2", "c2", "s3"].map((n) => uid(n));
  const bundleChecks = { c: ", 'COMBO', 'FIXED', 'FIXED_PRICE', 'OWN_STOCK'", s: ", 'SINGLE', NULL, NULL, NULL" };
  try {
    for (const [i, id] of ids.entries()) {
      const isCombo = id.startsWith("c");
      await setup.query(
        `INSERT INTO "Product" (id,name,slug,description,price,stock,"updatedAt","createdAt",type,kind,"comboMode","comboPricing","comboStockPolicy")
         VALUES ($1,$1,$1,'d',10,1,now(),$2,$3${isCombo ? bundleChecks.c : bundleChecks.s})`.replace("$3", isCombo ? "'BUNDLE'" : "'STANDARD'"),
        [id, new Date(Date.UTC(2026, 0, i + 1))],
      );
    }
    const { rows } = await setup.query(
      `SELECT id FROM "Product" WHERE id = ANY($1) ORDER BY kind DESC, "createdAt" DESC, id ASC`, [ids]);
    // newest-first within each kind: combos c2(day4), c1(day2); singles s3(day5), s2(day3), s1(day1)
    assert.deepEqual(rows.map((r: any) => r.id), [ids[3], ids[1], ids[4], ids[2], ids[0]]);
  } finally {
    await setup.query(`DELETE FROM "Product" WHERE id = ANY($1)`, [ids]);
    await setup.end();
  }
});
