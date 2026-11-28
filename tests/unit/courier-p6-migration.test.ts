/**
 * Static schema <-> migration consistency for P6. NOT a substitute for `prisma validate` / `prisma migrate diff` against a real database (neither could be
 * run in the build environment): it catches the common drift (a column in one place only, a destructive statement, an unsafe default).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const sql = readFileSync(new URL("../../prisma/migrations/20261126000000_courier_intelligence_p6/migration.sql", import.meta.url), "utf8");
const executable = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const model = (name: string) => {
  const m = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `model ${name} exists`);
  return m[1];
};

test("StoreSettings: five new columns exist in the schema and the migration with the CONSERVATIVE defaults (no reduction, no unverified credit)", () => {
  const body = model("StoreSettings");
  const cols: Record<string, { schema: RegExp; sql: RegExp }> = {
    trustMinSample: { schema: /trustMinSample\s+Int\s+@default\(5\)/, sql: /ADD COLUMN "trustMinSample" INTEGER NOT NULL DEFAULT 5/ },
    trustMinProviders: { schema: /trustMinProviders\s+Int\s+@default\(1\)/, sql: /ADD COLUMN "trustMinProviders" INTEGER NOT NULL DEFAULT 1/ },
    trustMaxAgeSeconds: { schema: /trustMaxAgeSeconds\s+Int\s+@default\(3600\)/, sql: /ADD COLUMN "trustMaxAgeSeconds" INTEGER NOT NULL DEFAULT 3600/ },
    trustRewardEnabled: { schema: /trustRewardEnabled\s+Boolean\s+@default\(false\)/, sql: /ADD COLUMN "trustRewardEnabled" BOOLEAN NOT NULL DEFAULT false/ },
    trustCreditUnverifiedPhone: { schema: /trustCreditUnverifiedPhone\s+Boolean\s+@default\(false\)/, sql: /ADD COLUMN "trustCreditUnverifiedPhone" BOOLEAN NOT NULL DEFAULT false/ },
  };
  for (const [name, re] of Object.entries(cols)) {
    assert.match(body, re.schema, `schema ${name}`);
    assert.match(executable, re.sql, `sql ${name}`);
  }
});

test("CourierIntelligenceSnapshot: every schema field has a column; the cache key is unique; indexes match; it stores no raw phone or payload", () => {
  const body = model("CourierIntelligenceSnapshot");
  const table = executable.match(/CREATE TABLE "CourierIntelligenceSnapshot" \(([\s\S]*?)\n\);/);
  assert.ok(table);
  const fields = ["id", "phoneHash", "phoneMasked", "provider", "status", "reason", "delivered", "cancelled", "returned", "failed", "total", "reportedDeliveryRate", "reportedCancellationRate", "fraudReports", "source", "checkedAt", "expiresAt"];
  for (const f of fields) {
    assert.match(body, new RegExp(`\\n\\s+${f}\\s`), `schema ${f}`);
    assert.match(table[1], new RegExp(`"${f}" `), `sql ${f}`);
  }
  // privacy by construction: no column that could hold a readable phone number or a provider payload
  for (const forbidden of ["phone ", "phoneRaw", "payload", "rawBody", "response", "json", "apiKey", "secret"]) assert.ok(!new RegExp(`\\n\\s+${forbidden}`, "i").test(body), `schema has no ${forbidden}`);
  assert.ok(!/"phone" |"payload"|"response"|"rawBody"/i.test(table[1]));
  assert.match(body, /@@unique\(\[phoneHash, provider, checkedAt\]\)/);
  assert.match(executable, /CREATE UNIQUE INDEX "CourierIntelligenceSnapshot_phoneHash_provider_checkedAt_key"/);
  assert.match(body, /@@index\(\[phoneHash, provider, checkedAt\]\)/);
  assert.match(executable, /CREATE INDEX "CourierIntelligenceSnapshot_phoneHash_provider_checkedAt_idx"/);
  assert.match(body, /@@index\(\[provider, checkedAt\]\)/);
  assert.match(body, /@@index\(\[checkedAt\]\)/);
  assert.match(executable, /CREATE INDEX "CourierIntelligenceSnapshot_checkedAt_idx"/);
  assert.match(body, /reportedDeliveryRate\s+Decimal\?\s+@db\.Decimal\(5, 2\)/);
  assert.match(table[1], /"reportedDeliveryRate" DECIMAL\(5,2\)/);
});

test("the migration is additive: no DROP / TYPE change / UPDATE / DELETE / backfill, and it documents a rollback", () => {
  for (const bad of [/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE)\b/i, /ALTER\s+COLUMN/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /SET\s+NOT\s+NULL/i, /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i]) {
    assert.doesNotMatch(executable, bad);
  }
  assert.match(sql, /ROLLBACK/);
  assert.match(sql, /DROP TABLE "CourierIntelligenceSnapshot"/); // only inside the rollback comment
  assert.doesNotMatch(executable, /DROP TABLE/);
  // ADD COLUMN on an existing table always has a default, so existing rows stay valid
  for (const stmt of executable.match(/ADD COLUMN [^,;]+/g) ?? []) assert.match(stmt, /DEFAULT/, stmt);
});
