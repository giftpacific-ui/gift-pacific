/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * REAL-DATABASE tests. They run only when TEST_DATABASE_URL points at a
 * disposable PostgreSQL database that has the migrations applied
 * (`prisma migrate deploy`) and the `pg` driver available. Otherwise they
 * are SKIPPED — they are NOT counted as passing.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/giftpacific_test pnpm test
 *
 * What they prove that the in-memory fake cannot: that PostgreSQL's
 * nextval() really never repeats under parallel connections, and that the
 * guarded `UPDATE … WHERE stock >= qty` statement really lets exactly one of
 * N parallel connections take the last unit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL not set — real-database tests skipped";

async function connect(): Promise<any> {
  // `pg` is not a dependency of the app; install it locally to run these.
  const { Client } = await import("pg" as string);
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

test("nextval('order_number_seq') is unique across 50 parallel connections", { skip }, async () => {
  const clients = await Promise.all(Array.from({ length: 50 }, connect));
  try {
    const rows = await Promise.all(clients.map((c) => c.query("SELECT nextval('order_number_seq') AS n")));
    const values = rows.map((r: any) => String(r.rows[0].n));
    assert.equal(new Set(values).size, 50);
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
});

test("guarded stock UPDATE lets exactly one of 20 parallel connections take the last unit", { skip }, async () => {
  const setup = await connect();
  const id = `it_${Date.now()}`;
  await setup.query(
    `INSERT INTO "Product" (id, name, slug, description, price, stock, "updatedAt") VALUES ($1, 'IT', $1, 'd', 10, 1, now())`,
    [id],
  );
  const clients = await Promise.all(Array.from({ length: 20 }, connect));
  try {
    const results = await Promise.all(
      clients.map((c) => c.query(`UPDATE "Product" SET stock = stock - 1 WHERE id = $1 AND stock >= 1`, [id])),
    );
    assert.equal(results.filter((r: any) => r.rowCount === 1).length, 1);
    const { rows } = await setup.query(`SELECT stock FROM "Product" WHERE id = $1`, [id]);
    assert.equal(rows[0].stock, 0);
  } finally {
    await setup.query(`DELETE FROM "Product" WHERE id = $1`, [id]);
    await Promise.all([setup, ...clients].map((c) => c.end()));
  }
});
