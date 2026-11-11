/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE checks for Phase 3 (advance payments / trust): skipped unless TEST_DATABASE_URL points at a DISPOSABLE PostgreSQL with ALL
 * migrations (incl. 20261111000000_advance_hardening) applied and the `pg` driver installed. NOT YET RUN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set -- real-database tests skipped";
async function connect(): Promise<any> {
  const { Client } = await import("pg" as string);
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}
const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
async function addOrder(c: any, o: { total?: number; required?: number; paid?: number } = {}) {
  const ch = uid("ch"), order = uid("o");
  await c.query(`INSERT INTO "SalesChannel" (id,key,name,kind) VALUES ($1,$1,'T','OTHER')`, [ch]);
  await c.query(
    `INSERT INTO "Order" (id,"orderNumber","confirmationToken",phone,"shippingSnapshot",subtotal,total,"channelId","advanceRequired","advancePaid","updatedAt") VALUES ($1,$1,$1,'0','{}'::jsonb,$2,$2,$3,$4,$5,now())`,
    [order, o.total ?? 1000, ch, o.required ?? 0, o.paid ?? 0],
  );
  return { ch, order, cleanup: async () => { await c.query(`DELETE FROM "Order" WHERE id=$1`, [order]); await c.query(`DELETE FROM "SalesChannel" WHERE id=$1`, [ch]); } };
}

test("the money CHECK (added NOT VALID) refuses a new order whose advance exceeds its total, and a paid advance above the total", { skip }, async () => {
  const c = await connect();
  const ch = uid("ch");
  await c.query(`INSERT INTO "SalesChannel" (id,key,name,kind) VALUES ($1,$1,'T','OTHER')`, [ch]);
  const ins = (required: number, paid: number) =>
    c.query(`INSERT INTO "Order" (id,"orderNumber","confirmationToken",phone,"shippingSnapshot",subtotal,total,"channelId","advanceRequired","advancePaid","updatedAt") VALUES ($1,$1,$1,'0','{}'::jsonb,100,100,$2,$3,$4,now())`, [uid("o"), ch, required, paid]);
  try {
    await ins(100, 100);                                                                   // exactly the total: allowed
    await assert.rejects(ins(101, 0), (e: any) => e.code === "23514");                     // required > total
    await assert.rejects(ins(0, 101), (e: any) => e.code === "23514");                     // paid > total
    await assert.rejects(ins(-1, 0), (e: any) => e.code === "23514");
  } finally { await c.query(`DELETE FROM "Order" WHERE "channelId"=$1`, [ch]); await c.query(`DELETE FROM "SalesChannel" WHERE id=$1`, [ch]); await c.end(); }
});

test("a wallet transaction id can be credited to only one payment even when two admins verify it at the same instant", { skip }, async () => {
  const setup = await connect();
  const a = await addOrder(setup), b = await addOrder(setup);
  const ref = uid("TX").toUpperCase();
  const [c1, c2] = await Promise.all([connect(), connect()]);
  const verify = async (c: any, order: string) => {
    try {
      await c.query(`INSERT INTO "Payment" (id,"orderId",method,status,amount,"providerRef",kind) VALUES ($1,$2,'BKASH','PAID',200,$3,'ADVANCE')`, [uid("p"), order, ref]);
      return "ok";
    } catch (e: any) { return e.code; }
  };
  try {
    const r = await Promise.all([verify(c1, a.order), verify(c2, b.order)]);
    assert.deepEqual([...r].sort(), ["23505", "ok"]);
  } finally { await a.cleanup(); await b.cleanup(); await Promise.all([setup, c1, c2].map((c: any) => c.end())); }
});

test("a waiver/review/verification audit row is append-only data: indexed lookups by entity work and the table accepts the documented shape", { skip }, async () => {
  const c = await connect();
  const f = await addOrder(c, { total: 500, required: 200 });
  const id = uid("ae");
  try {
    await c.query(`INSERT INTO "AdminAuditEvent" (id,"actorId",action,"entityType","entityId",detail) VALUES ($1,$2,'ADVANCE_WAIVED','ORDER',$3,$4::jsonb)`, [id, "admin-x", f.order, JSON.stringify({ reason: "phoned" })]);
    const { rows } = await c.query(`SELECT action, detail->>'reason' AS reason FROM "AdminAuditEvent" WHERE "entityType"='ORDER' AND "entityId"=$1`, [f.order]);
    assert.deepEqual(rows, [{ action: "ADVANCE_WAIVED", reason: "phoned" }]);
  } finally { await c.query(`DELETE FROM "AdminAuditEvent" WHERE id=$1`, [id]); await f.cleanup(); await c.end(); }
});

test("migration back-fill rule: only still-PENDING orders whose own snapshot says needsReview get the review gate", { skip }, async () => {
  const c = await connect();
  const pendingFlagged = await addOrder(c), confirmedFlagged = await addOrder(c);
  try {
    await c.query(`UPDATE "Order" SET status='PENDING', "trustSnapshot"='{"needsReview":true}'::jsonb WHERE id=$1`, [pendingFlagged.order]);
    await c.query(`UPDATE "Order" SET status='CONFIRMED', "trustSnapshot"='{"needsReview":true}'::jsonb WHERE id=$1`, [confirmedFlagged.order]);
    await c.query(`UPDATE "Order" SET "trustReviewRequired" = true WHERE "status" = 'PENDING' AND ("trustSnapshot" ->> 'needsReview') = 'true' AND id = ANY($1)`, [[pendingFlagged.order, confirmedFlagged.order]]);
    const { rows } = await c.query(`SELECT id, "trustReviewRequired" AS r FROM "Order" WHERE id = ANY($1)`, [[pendingFlagged.order, confirmedFlagged.order]]);
    const by = Object.fromEntries(rows.map((r: any) => [r.id, r.r]));
    assert.deepEqual([by[pendingFlagged.order], by[confirmedFlagged.order]], [true, false]);
  } finally { await pendingFlagged.cleanup(); await confirmedFlagged.cleanup(); await c.end(); }
});
