/**
 * Static schema <-> migration consistency for P5. This is NOT a substitute for `prisma validate` / `prisma migrate diff` on a real database
 * (neither could be run in the build environment); it catches the common drift: a column in one place and not the other, or a destructive statement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const sql = readFileSync(new URL("../../prisma/migrations/20261125000000_courier_p5/migration.sql", import.meta.url), "utf8");
const executable = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const ORDER_COLUMNS: Record<string, string> = {
  courierEventAt: "TIMESTAMP(3)", courierLastSyncAt: "TIMESTAMP(3)", courierCodAmount: "DECIMAL(10,2)",
  courierRemoteConfirmedAt: "TIMESTAMP(3)", courierSyncLeaseUntil: "TIMESTAMP(3)",
};

function model(name: string) {
  const m = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `model ${name} exists`);
  return m[1];
}

test("every new Order column is in the schema (optional) and in the migration as a NULLable column", () => {
  const order = model("Order");
  for (const [col, type] of Object.entries(ORDER_COLUMNS)) {
    assert.match(order, new RegExp(`\\n\\s+${col}\\s+(DateTime|Decimal)\\?`), `schema: ${col}`);
    assert.match(executable, new RegExp(`ADD COLUMN "${col}" ${type.replace(/[()]/g, "\\$&")}(,|;)`), `sql: ${col}`);
  }
  assert.match(order, /shipmentEvents\s+CourierShipmentEvent\[\]/);
  assert.match(order, /codResolutions\s+CourierCodResolution\[\]/);
  assert.match(order, /@@index\(\[courierBookingStatus, courierLastEventAt\]\)/);
  assert.match(executable, /CREATE INDEX "Order_courierBookingStatus_courierLastEventAt_idx"/);
});

test("new tables: every schema field has a column, unique/indexes/FKs match", () => {
  for (const [name, fields] of Object.entries({
    CourierShipmentEvent: ["id", "orderId", "provider", "consignmentId", "source", "rawStatus", "mappedEvent", "providerEventAt", "codAmount", "outcome", "dedupeKey", "createdAt"],
    CourierCodResolution: ["id", "orderId", "flagCode", "amount", "amountCents", "action", "reason", "resolvedById", "createdAt"],
  })) {
    const body = model(name);
    const table = executable.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`));
    assert.ok(table, `sql table ${name}`);
    for (const f of fields) {
      assert.match(body, new RegExp(`\\n\\s+${f}\\s`), `schema ${name}.${f}`);
      assert.match(table[1], new RegExp(`"${f}" `), `sql ${name}.${f}`);
    }
    assert.match(executable, new RegExp(`"${name}_orderId_fkey" FOREIGN KEY \\("orderId"\\) REFERENCES "Order"\\("id"\\) ON DELETE RESTRICT`));
  }
  assert.match(model("CourierShipmentEvent"), /dedupeKey\s+String\?\s+@unique/);
  assert.match(executable, /CREATE UNIQUE INDEX "CourierShipmentEvent_dedupeKey_key"/);
  assert.match(model("CourierCodResolution"), /@@unique\(\[orderId, flagCode, amountCents\]\)/);
  assert.match(executable, /CREATE UNIQUE INDEX "CourierCodResolution_orderId_flagCode_amountCents_key"/);
});

test("the migration is additive: no DROP / TYPE change / UPDATE / DELETE / SET NOT NULL, and both history tables are append-only", () => {
  for (const bad of [/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE)\b/i, /ALTER\s+COLUMN/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /SET\s+NOT\s+NULL/i, /\bTRUNCATE\b/i]) {
    assert.doesNotMatch(executable, bad);
  }
  assert.match(executable, /CREATE TRIGGER "CourierShipmentEvent_append_only"\s+BEFORE UPDATE OR DELETE ON "CourierShipmentEvent"/);
  assert.match(executable, /CREATE TRIGGER "CourierCodResolution_append_only"\s+BEFORE UPDATE OR DELETE ON "CourierCodResolution"/);
  assert.match(sql, /ROLLBACK/);
});

test("the new columns can never reach a customer: they are all in the internal-field strip list", () => {
  const svc = readFileSync(new URL("../../src/server/services/order.service.ts", import.meta.url), "utf8");
  const list = svc.slice(svc.indexOf("const COURIER_INTERNAL_FIELDS = ["), svc.indexOf("] as const;", svc.indexOf("const COURIER_INTERNAL_FIELDS = [")));
  for (const col of Object.keys(ORDER_COLUMNS)) assert.ok(list.includes(`"${col}"`), col);
});
