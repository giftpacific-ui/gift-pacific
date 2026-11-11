import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyDatabase, isLocalDatabase, isStrongPassword, resolveSeedConfig, MIN_ADMIN_PASSWORD } from "../../prisma/seed-config";

// POLICY under test: admin-only, fail closed. Both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are ALWAYS required;
// there is no development default and no demo data, on any database.
const LOCAL = "postgresql://u:p@localhost:5432/giftpacific";
const REMOTE = "postgresql://u:p@ep-cool-123.neon.tech/giftpacific";
const STRONG = "Correct-Horse-Battery-9";
const OWNER = "owner@shop.example";

const errorsOf = (env: Record<string, string | undefined>): string[] => {
  const r = resolveSeedConfig(env);
  assert.equal(r.ok, false, JSON.stringify({ ...env, DATABASE_URL: "<redacted>", SEED_ADMIN_PASSWORD: "<redacted>" }));
  return r.ok ? [] : r.errors;
};

test("credentials are required EVERYWHERE — a local development database gets no default admin", () => {
  for (const env of [{ DATABASE_URL: LOCAL }, { DATABASE_URL: LOCAL, NODE_ENV: "development" }, { DATABASE_URL: LOCAL, NODE_ENV: "test" }, { DATABASE_URL: REMOTE }, {}]) {
    const msg = errorsOf(env).join(" ");
    assert.match(msg, /SEED_ADMIN_EMAIL must be set explicitly/);
    assert.match(msg, /SEED_ADMIN_PASSWORD must be set explicitly/);
  }
});

test("blank and whitespace-only values count as unset (never become an empty or default password)", () => {
  for (const blank of ["", "   ", "\t"]) {
    const msg = errorsOf({ DATABASE_URL: LOCAL, SEED_ADMIN_EMAIL: blank, SEED_ADMIN_PASSWORD: blank }).join(" ");
    assert.match(msg, /SEED_ADMIN_EMAIL must be set explicitly/);
    assert.match(msg, /SEED_ADMIN_PASSWORD must be set explicitly/);
  }
  errorsOf({ DATABASE_URL: LOCAL, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: "" });
  errorsOf({ DATABASE_URL: LOCAL, SEED_ADMIN_EMAIL: "", SEED_ADMIN_PASSWORD: STRONG });
});

test("old well-known defaults are rejected as passwords", () => {
  for (const known of ["ChangeMe123!", "changeme123!", "Password123!", "PASSWORD123!", "admin1234567"]) {
    assert.equal(isStrongPassword(known, OWNER), false, known);
    errorsOf({ DATABASE_URL: LOCAL, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: known });
  }
});

test("weak passwords are rejected everywhere; the message never echoes the password", () => {
  const weak = ["short1A", "alllowercase12345", "ALLUPPERCASE12345", "NoDigitsHereAtAll", "owner-Shop-2024-Aa1", "x".repeat(MIN_ADMIN_PASSWORD - 1)];
  for (const w of weak) {
    for (const base of [{ NODE_ENV: "production", DATABASE_URL: REMOTE }, { DATABASE_URL: LOCAL }, { DATABASE_URL: undefined }]) {
      errorsOf({ ...base, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: w });
    }
    assert.equal(isStrongPassword(w, OWNER), false, w);
  }
  const msg = errorsOf({ DATABASE_URL: REMOTE, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: "hunter2-secret" }).join(" ");
  assert.ok(!msg.includes("hunter2-secret"));
});

test("invalid email is rejected", () => {
  assert.match(errorsOf({ DATABASE_URL: LOCAL, SEED_ADMIN_EMAIL: "not-an-email", SEED_ADMIN_PASSWORD: STRONG }).join(" "), /not a valid email/);
});

test("valid explicit credentials are accepted on any database / NODE_ENV; email is trimmed and lower-cased", () => {
  for (const base of [
    { NODE_ENV: "production", DATABASE_URL: REMOTE }, { DATABASE_URL: REMOTE }, { NODE_ENV: "development", DATABASE_URL: REMOTE },
    {}, { NODE_ENV: "production", DATABASE_URL: LOCAL }, { DATABASE_URL: LOCAL }, { NODE_ENV: "test", DATABASE_URL: LOCAL },
  ]) {
    const r = resolveSeedConfig({ ...base, SEED_ADMIN_EMAIL: " Owner@Shop.Example ", SEED_ADMIN_PASSWORD: STRONG });
    assert.ok(r.ok, JSON.stringify(base));
    assert.equal(r.config.adminEmail, "owner@shop.example");
    assert.equal(r.config.adminPassword, STRONG);
    assert.equal(r.config.isProduction, base.NODE_ENV === "production");
  }
});

test("a non-local database only produces a warning (credentials were explicit); a verified-local one produces none", () => {
  const remote = resolveSeedConfig({ DATABASE_URL: REMOTE, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: STRONG });
  assert.ok(remote.ok);
  assert.match(remote.config.warnings.join(" "), /does not look like a local database/);
  assert.equal(remote.config.databaseTrust, "remote");
  const local = resolveSeedConfig({ DATABASE_URL: LOCAL, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: STRONG });
  assert.ok(local.ok);
  assert.deepEqual(local.config.warnings, []);
  // production never downgrades to a warning-only path for missing credentials
  errorsOf({ NODE_ENV: "production", DATABASE_URL: REMOTE });
});

test("database classification is conservative", () => {
  for (const url of [
    undefined, "", "   ", "garbage", "localhost:5432/giftpacific", "mysql://u:p@localhost/giftpacific", "file:./dev.db",
    "postgresql://u:p@/giftpacific", "postgresql://u:p@localhost,remote.example:5432/giftpacific",
    "postgresql://u:p@localhost:5432/giftpacific?host=remote.example", "postgresql://u:p@localhost/giftpacific?hostaddr=10.1.2.3",
    "postgresql://u:p@localhost./giftpacific", "postgresql://u:p@localhost.evil.example/giftpacific", "postgresql://u:p@db.internal.example/giftpacific",
  ]) {
    assert.notEqual(classifyDatabase(url), "verified-local", String(url));
    assert.equal(isLocalDatabase(url), false, String(url));
  }
  assert.equal(classifyDatabase(REMOTE), "remote");
  assert.equal(classifyDatabase(undefined), "unknown");
  assert.equal(classifyDatabase("postgres://u:p@127.0.0.1:5432/giftpacific"), "verified-local");
  assert.equal(classifyDatabase("postgresql://u:p@[::1]:5432/giftpacific"), "verified-local");
  assert.equal(classifyDatabase("postgresql://u:p@db:5432/giftpacific"), "verified-local");
});

test("source guards: no default credential literals in the seed code; seed.ts stays a thin entry; docs agree", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  const seed = read("prisma/seed.ts");
  assert.match(seed, /runSeed\(process\.env,\s*\(\) => new PrismaClient\(\)\)/);
  assert.ok(!/SEED_ADMIN_PASSWORD/.test(seed));
  for (const file of ["prisma/seed-runner.ts", "prisma/seed-config.ts"]) {
    const src = read(file);
    assert.ok(!/ChangeMe123!/.test(src.replace(/KNOWN_DEFAULT_PASSWORDS[^;]*;/s, "")), `${file}: default password literal outside the deny-list`);
    assert.ok(!/DEV_ADMIN_(EMAIL|PASSWORD)/.test(src), `${file}: development admin constants must not exist`);
    assert.ok(!/SEED_ADMIN_PASSWORD\s*\?\?/.test(src), `${file}: the buggy \`?? default\` pattern is back`);
  }
  const runner = read("prisma/seed-runner.ts");
  assert.ok(!/user\.upsert\(/.test(runner), "admin must be find-then-create, never upserted");
  assert.ok(!/console\.(log|warn|error)\([^)]*(ADMIN_PASSWORD|DATABASE_URL)/.test(runner), "secrets must not be logged");
  const example = read(".env.example");
  assert.match(example, /SEED_ADMIN_EMAIL=""/);
  assert.match(example, /SEED_ADMIN_PASSWORD=""/);
  assert.ok(!/ChangeMe123!/.test(example), ".env.example must not advertise a default admin password");
  assert.ok(!/SEED_DEMO_DATA/.test(example), ".env.example must not document the removed demo-data flag");
});
