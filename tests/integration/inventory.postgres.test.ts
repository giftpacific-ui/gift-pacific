/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE concurrency tests for the inventory statements (skipped unless TEST_DATABASE_URL points at a
 * disposable PostgreSQL with ALL migrations applied and the `pg` driver installed). NOT YET RUN.
 * They execute the same SQL shape the reservation code issues through Prisma:
 *   guarded decrement:  UPDATE ... SET stock = stock - $n WHERE id = $id AND stock >= $n
 *   limited queue:      UPDATE ... SET procurementPending = procurementPending + $n WHERE id = $id AND procurementPending <= $limit - $n
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set — real-database tests skipped";
async function connect(): Promise<any> {
  const { Client } = await import("pg" as string);
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}
const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const addProduct = (c: any, id: string, stock: number, pending = 0) =>
  c.query(`INSERT INTO "Product" (id,name,slug,description,price,stock,"procurementPending","updatedAt") VALUES ($1,'T',$1,'x',10,$2,$3,now())`, [id, stock, pending]);

test("two buyers racing for the last unit: exactly one guarded decrement succeeds, stock never negative", { skip }, async () => {
  const setup = await connect();
  const id = uid("inv");
  await addProduct(setup, id, 1);
  const clients = await Promise.all(Array.from({ length: 8 }, connect));
  try {
    const results = await Promise.all(clients.map(async (c: any) => (await c.query(`UPDATE "Product" SET stock = stock - 1 WHERE id = $1 AND stock >= 1`, [id])).rowCount));
    assert.equal(results.filter((n: number) => n === 1).length, 1);
    assert.equal((await setup.query(`SELECT stock FROM "Product" WHERE id=$1`, [id])).rows[0].stock, 0);
  } finally {
    await setup.query(`DELETE FROM "Product" WHERE id=$1`, [id]);
    await Promise.all([setup, ...clients].map((c: any) => c.end()));
  }
});

test("the CHECK constraint refuses negative stock even for an unguarded write", { skip }, async () => {
  const c = await connect();
  const id = uid("chk");
  await addProduct(c, id, 1);
  try {
    await assert.rejects(c.query(`UPDATE "Product" SET stock = stock - 2 WHERE id = $1`, [id]), (e: any) => e.code === "23514");
  } finally {
    await c.query(`DELETE FROM "Product" WHERE id=$1`, [id]);
    await c.end();
  }
});

test("procurement limit under contention: pending never exceeds the cap", { skip }, async () => {
  const setup = await connect();
  const id = uid("lim");
  await addProduct(setup, id, 0, 0);
  await setup.query(`UPDATE "Product" SET "procurementLimit" = 5, "allowBackorder" = true WHERE id=$1`, [id]);
  const clients = await Promise.all(Array.from({ length: 10 }, connect));
  try {
    const results = await Promise.all(clients.map(async (c: any) =>
      (await c.query(`UPDATE "Product" SET "procurementPending" = "procurementPending" + 2 WHERE id = $1 AND "procurementPending" <= 5 - 2`, [id])).rowCount));
    assert.equal(results.filter((n: number) => n === 1).length, 2); // 2 + 2 = 4 <= 5; a third would be 6
    assert.equal((await setup.query(`SELECT "procurementPending" p FROM "Product" WHERE id=$1`, [id])).rows[0].p, 4);
  } finally {
    await setup.query(`DELETE FROM "Product" WHERE id=$1`, [id]);
    await Promise.all([setup, ...clients].map((c: any) => c.end()));
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Phase 2 (stock-movement integrity). NOT RUN — need a disposable PostgreSQL with ALL migrations (incl. 20261110*) + the `pg` driver.
// ---------------------------------------------------------------------------------------------------------------------------------
async function addOrderWithLine(c: any, o: { stockDeducted: number; procurementReceivedQty?: number; quantity?: number }) {
  const ch = uid("ch"), prod = uid("p"), order = uid("o"), item = uid("i");
  await c.query(`INSERT INTO "SalesChannel" (id,key,name,kind) VALUES ($1,$1,'T','OTHER')`, [ch]);
  await addProduct(c, prod, 10);
  await c.query(`INSERT INTO "Order" (id,"orderNumber","confirmationToken",phone,"shippingSnapshot",subtotal,total,"channelId","updatedAt") VALUES ($1,$1,$1,'0','{}'::jsonb,1,1,$2,now())`, [order, ch]);
  await c.query(
    `INSERT INTO "OrderItem" (id,"orderId","productId","productName",quantity,"unitPrice","lineTotal","stockDeducted","procurementQty","procurementReceivedQty") VALUES ($1,$2,$3,'T',$4,1,1,$5,$6,$6)`,
    [item, order, prod, o.quantity ?? o.stockDeducted, o.stockDeducted, o.procurementReceivedQty ?? 0],
  );
  return { ch, prod, order, item, cleanup: async () => { await c.query(`DELETE FROM "Order" WHERE id=$1`, [order]); await c.query(`DELETE FROM "Product" WHERE id=$1`, [prod]); await c.query(`DELETE FROM "SalesChannel" WHERE id=$1`, [ch]); } };
}

test("the counters CHECK refuses returning more units than left stock, even for an unguarded write", { skip }, async () => {
  const c = await connect();
  const f = await addOrderWithLine(c, { stockDeducted: 3 });
  try {
    await c.query(`UPDATE "OrderItem" SET "stockReturnedQty" = 2, "stockDiscardedQty" = 1 WHERE id = $1`, [f.item]); // exactly out: allowed
    await assert.rejects(c.query(`UPDATE "OrderItem" SET "stockDiscardedQty" = 2 WHERE id = $1`, [f.item]), (e: any) => e.code === "23514"); // 2 + 2 > 3
    await assert.rejects(c.query(`UPDATE "OrderItem" SET "stockReturnedQty" = -1 WHERE id = $1`, [f.item]), (e: any) => e.code === "23514");
  } finally { await f.cleanup(); await c.end(); }
});

test("an incident idempotency key is unique, and so is a stock-ledger idempotency key", { skip }, async () => {
  const c = await connect();
  const f = await addOrderWithLine(c, { stockDeducted: 1 });
  const key = uid("k");
  try {
    await c.query(`INSERT INTO "FinancialIncident" (id,kind,"occurredOn","idempotencyKey") VALUES ($1,'OTHER',CURRENT_DATE,$2)`, [uid("f"), key]);
    await assert.rejects(c.query(`INSERT INTO "FinancialIncident" (id,kind,"occurredOn","idempotencyKey") VALUES ($1,'OTHER',CURRENT_DATE,$2)`, [uid("f"), key]), (e: any) => e.code === "23505");
    await c.query(`INSERT INTO "StockAdjustment" (id,"productId",delta,"stockAfter",reason,"idempotencyKey") VALUES ($1,$2,1,1,'t',$3)`, [uid("s"), f.prod, key]);
    await assert.rejects(c.query(`INSERT INTO "StockAdjustment" (id,"productId",delta,"stockAfter",reason,"idempotencyKey") VALUES ($1,$2,1,1,'t',$3)`, [uid("s"), f.prod, key]), (e: any) => e.code === "23505");
  } finally {
    await c.query(`DELETE FROM "FinancialIncident" WHERE "idempotencyKey" = $1`, [key]); await c.query(`DELETE FROM "StockAdjustment" WHERE "idempotencyKey" = $1`, [key]);
    await f.cleanup(); await c.end();
  }
});

test("racing return incidents: the row lock + compare-and-set let exactly one of two overlapping restocks through", { skip }, async () => {
  const setup = await connect();
  const f = await addOrderWithLine(setup, { stockDeducted: 3 });
  const [c1, c2] = await Promise.all([connect(), connect()]);
  // The statement sequence recordIncident() runs: no-op write takes the row lock, fresh read, compare-and-set the counters, then credit stock.
  const restock = async (c: any, qty: number) => {
    await c.query("BEGIN");
    try {
      await c.query(`UPDATE "OrderItem" SET "stockReturnedQty" = "stockReturnedQty" + 0 WHERE id = $1`, [f.item]);
      const { rows } = await c.query(`SELECT "stockReturnedQty" r, "stockDiscardedQty" d, "stockDeducted" + "procurementReceivedQty" AS out FROM "OrderItem" WHERE id = $1`, [f.item]);
      const left = rows[0].out - rows[0].r - rows[0].d;
      if (qty > left) { await c.query("ROLLBACK"); return "refused"; }
      const cas = await c.query(`UPDATE "OrderItem" SET "stockReturnedQty" = "stockReturnedQty" + $2 WHERE id = $1 AND "stockReturnedQty" = $3 AND "stockDiscardedQty" = $4`, [f.item, qty, rows[0].r, rows[0].d]);
      if (cas.rowCount !== 1) { await c.query("ROLLBACK"); return "conflict"; }
      await c.query(`UPDATE "Product" SET stock = stock + $2 WHERE id = $1`, [f.prod, qty]);
      await c.query("COMMIT");
      return "ok";
    } catch (e) { await c.query("ROLLBACK"); throw e; }
  };
  try {
    const results = await Promise.all([restock(c1, 2), restock(c2, 2)]);
    assert.equal(results.filter((r) => r === "ok").length, 1);
    assert.equal((await setup.query(`SELECT stock FROM "Product" WHERE id=$1`, [f.prod])).rows[0].stock, 12);   // 10 + 2, never + 4
    assert.equal((await setup.query(`SELECT "stockReturnedQty" r FROM "OrderItem" WHERE id=$1`, [f.item])).rows[0].r, 2);
  } finally { await f.cleanup(); await Promise.all([setup, c1, c2].map((c: any) => c.end())); }
});

test("two concurrent releases of the same line: the stockRestoredAt claim lets exactly one credit stock", { skip }, async () => {
  const setup = await connect();
  const f = await addOrderWithLine(setup, { stockDeducted: 3 });
  const clients = await Promise.all(Array.from({ length: 6 }, connect));
  try {
    const claims = await Promise.all(clients.map(async (c: any) => (await c.query(`UPDATE "OrderItem" SET "stockRestoredAt" = now() WHERE id = $1 AND "stockRestoredAt" IS NULL`, [f.item])).rowCount));
    assert.equal(claims.filter((n: number) => n === 1).length, 1);
  } finally { await f.cleanup(); await Promise.all([setup, ...clients].map((c: any) => c.end())); }
});
