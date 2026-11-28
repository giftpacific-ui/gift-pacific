/**
 * Static schema <-> migration consistency for the multi-provider courier work (two migrations). NOT a substitute for `prisma validate` /
 * `prisma migrate diff` against a real database (neither could be run in the build environment): it catches the common drift (a column in
 * one place only, a destructive statement, an unsafe constraint) and checks the safety properties promised in the migration comments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../../prisma/", import.meta.url);
const schema = readFileSync(new URL("schema.prisma", root), "utf8");
const read = (dir: string) => readFileSync(new URL(`migrations/${dir}/migration.sql`, root), "utf8");
const code = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const model = (name: string) => {
  const m = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `model ${name} exists`);
  return m[1];
};

const multi = read("20261129000000_courier_multi_provider");
const unique = read("20261130000000_courier_consignment_unique");

test("multi-provider migration: CourierConnectionCheck has every schema field as a column, provider is the key, and nothing is dropped or rewritten", () => {
  const body = model("CourierConnectionCheck");
  const table = code(multi).match(/CREATE TABLE "CourierConnectionCheck" \(([\s\S]*?)\n\);/);
  assert.ok(table);
  for (const f of ["provider", "ok", "failureKind", "message", "fingerprint", "lastSuccessAt", "checkedAt", "checkedById"]) {
    assert.match(body, new RegExp(`\\n\\s+${f}\\s`), `schema ${f}`);
    assert.match(table[1], new RegExp(`"${f}"`), `sql ${f}`);
  }
  assert.match(body, /provider\s+String\s+@id/);
  assert.match(table[1], /CONSTRAINT "CourierConnectionCheck_pkey" PRIMARY KEY \("provider"\)/);
  // nullable exactly where the schema says so
  assert.match(table[1], /"failureKind" TEXT,/);
  assert.match(table[1], /"fingerprint" TEXT NOT NULL/);
  assert.match(table[1], /"checkedAt" TIMESTAMP\(3\) NOT NULL/);
  assert.doesNotMatch(code(multi), /\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
});

test("multi-provider migration: CourierShipmentEvent.note is a NULLable column in both places (the append-only table needs no backfill)", () => {
  assert.match(model("CourierShipmentEvent"), /\n\s+note\s+String\?/);
  assert.match(code(multi), /ALTER TABLE "CourierShipmentEvent" ADD COLUMN "note" TEXT;/);
  assert.doesNotMatch(code(multi), /"note" TEXT NOT NULL/);
});

test("multi-provider migration documents its rollback, and the rollback matches what it created", () => {
  assert.match(multi, /ROLLBACK/);
  assert.match(multi, /DROP TABLE "CourierConnectionCheck"/);
  assert.match(multi, /DROP COLUMN "note"/);
});

test("the connection-check row stores no secret: only a fingerprint, flags and a bounded message", () => {
  const body = model("CourierConnectionCheck");
  const fields = body.replace(/\/\/\/.*$/gm, "");
  assert.ok(!/\b(apiKey|apiSecret|token|password)\b/i.test(fields), "no credential-shaped field");
  assert.match(fields, /fingerprint\s+String/);
});

test("consignment unique migration: one additive CREATE UNIQUE INDEX on (courierProvider, courierConsignmentId), matching the schema", () => {
  const sql = code(unique);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "Order_courierProvider_courierConsignmentId_key" ON "Order"\("courierProvider", "courierConsignmentId"\)/);
  assert.match(model("Order"), /@@unique\(\[courierProvider, courierConsignmentId\]\)/);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE|ALTER)\b/i);
  assert.doesNotMatch(sql, /UPDATE\s+"Order"/i);
});

test("consignment unique migration is SAFE on existing data: it checks for duplicates first and skips (with a notice) instead of failing the deploy", () => {
  const sql = code(unique);
  assert.match(sql, /GROUP BY "courierProvider", "courierConsignmentId"\s+HAVING COUNT\(\*\) > 1/);
  assert.match(sql, /RAISE NOTICE/);
  assert.match(sql, /IF EXISTS/);
  assert.match(sql, /ELSE\s+CREATE UNIQUE INDEX/);
  // it only ever considers rows that actually hold a consignment
  assert.match(sql, /"courierProvider" IS NOT NULL AND "courierConsignmentId" IS NOT NULL/);
  assert.match(unique, /ROLLBACK/);
  assert.match(unique, /DROP INDEX IF EXISTS "Order_courierProvider_courierConsignmentId_key"/);
});

test("consignment unique migration: dollar-quoting is balanced (a broken DO block would fail the deploy)", () => {
  const sql = code(unique);
  assert.equal((sql.match(/\$\$/g) ?? []).length, 2);
  assert.match(sql, /DO \$\$\s+BEGIN[\s\S]*END\s+\$\$;/);
});

test("migrations are strictly ordered after the previous courier migration and the lock file is untouched", () => {
  const dirs = readdirSync(new URL("migrations/", root)).filter((d) => /^\d{14}_/.test(d)).sort();
  const iMulti = dirs.indexOf("20261129000000_courier_multi_provider");
  assert.ok(iMulti >= 0);
  assert.equal(dirs[iMulti + 1], "20261130000000_courier_consignment_unique");
  // Later phases add migrations after these two (Prompt 07: 20261201000000_email_marketing_architecture_p07); what matters is that none slipped in between.
  assert.ok(dirs.slice(iMulti + 2).every((d) => d > "20261130000000_courier_consignment_unique"));
  assert.match(readFileSync(new URL("migrations/migration_lock.toml", root), "utf8"), /provider = "postgresql"/);
});
