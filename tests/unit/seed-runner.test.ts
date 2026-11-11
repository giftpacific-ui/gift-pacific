import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { runSeed, SeedConfigError } from "../../prisma/seed-runner";

/**
 * A recording mock of the Prisma client. Nothing here can reach a database.
 * Reads return what the test configured; every write is recorded.
 */
type Call = { model: string; op: string; args: unknown };
type Existing = { id: string; role: "ADMIN" | "CUSTOMER" } | null;
const READS = new Set(["findUnique", "findFirst", "findMany", "count"]);

function makeMock(existing: Existing = null) {
  const calls: Call[] = [];
  const state = { created: 0, disconnected: 0 };
  const model = (name: string) =>
    new Proxy({}, {
      get: (_t, op: string) => async (args: unknown) => {
        calls.push({ model: name, op, args });
        if (name === "user" && op === "findUnique") return existing;
        if (READS.has(op)) return null;
        return { id: `${name}_id` };
      },
    });
  const client = new Proxy({}, {
    get: (_t, prop: string) => (prop === "$disconnect" ? async () => void state.disconnected++ : model(prop)),
  }) as unknown as PrismaClient;
  return { calls, state, factory: () => { state.created++; return client; }, writes: () => calls.filter((c) => !READS.has(c.op)) };
}

function makeDeps() {
  const hashed: string[] = [];
  const lines: string[] = [];
  return {
    hashed, lines,
    deps: {
      hash: async (plain: string) => { hashed.push(plain); return "HASH(" + plain.length + ")"; },
      logger: { log: (m: string) => void lines.push(m), warn: (m: string) => void lines.push(m) },
    },
  };
}

const LOCAL = "postgresql://dbuser:dbpass-SECRET@localhost:5432/giftpacific";
const REMOTE = "postgresql://dbuser:dbpass-SECRET@ep-cool-123.neon.tech/giftpacific";
const STRONG = "Correct-Horse-Battery-9";
const OWNER = "owner@shop.example";

test("valid explicit credentials create exactly one thing: the admin user (any database, any NODE_ENV)", async () => {
  for (const base of [{ NODE_ENV: "production", DATABASE_URL: REMOTE }, { DATABASE_URL: REMOTE }, { NODE_ENV: "development", DATABASE_URL: REMOTE }, { DATABASE_URL: LOCAL }]) {
    const m = makeMock();
    const d = makeDeps();
    const out = await runSeed({ ...base, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: STRONG }, m.factory, d.deps);
    assert.deepEqual(out, { adminCreated: true, adminEmail: OWNER });
    assert.deepEqual(d.hashed, [STRONG]);
    assert.deepEqual(m.writes().map((c) => `${c.model}.${c.op}`), ["user.create"]); // no settings, products, coupons, banners, orders
    const data = (m.writes()[0].args as { data: Record<string, string> }).data;
    assert.equal(data.role, "ADMIN");
    assert.equal(data.email, OWNER);
    assert.equal(data.passwordHash, "HASH(" + STRONG.length + ")"); // plain text is never stored
    assert.equal(m.state.disconnected, 1);
  }
});

test("a local development database no longer gets a default admin or demo data: no client, no calls", async () => {
  const m = makeMock();
  const d = makeDeps();
  await assert.rejects(runSeed({ DATABASE_URL: LOCAL }, m.factory, d.deps), SeedConfigError);
  assert.equal(m.state.created, 0);
  assert.equal(m.calls.length, 0);
  assert.equal(d.hashed.length, 0);
});

test("unsafe configurations all fail BEFORE any client is created or any write happens", async () => {
  const cases: [string, Record<string, string | undefined>][] = [
    ["production, no creds", { NODE_ENV: "production", DATABASE_URL: REMOTE }],
    ["production, only email", { NODE_ENV: "production", DATABASE_URL: REMOTE, SEED_ADMIN_EMAIL: OWNER }],
    ["production, blank password", { NODE_ENV: "production", DATABASE_URL: REMOTE, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: "  " }],
    ["weak password", { DATABASE_URL: REMOTE, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: "password1" }],
    ["old default password", { DATABASE_URL: LOCAL, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: "ChangeMe123!" }],
    ["no env at all", {}],
    ["garbage DATABASE_URL, no creds", { DATABASE_URL: "not a url" }],
    ["local DB, NODE_ENV=production, no creds", { DATABASE_URL: LOCAL, NODE_ENV: "production" }],
    ["invalid email", { DATABASE_URL: REMOTE, SEED_ADMIN_EMAIL: "nope", SEED_ADMIN_PASSWORD: STRONG }],
  ];
  for (const [label, env] of cases) {
    const m = makeMock();
    const d = makeDeps();
    await assert.rejects(runSeed(env, m.factory, d.deps), SeedConfigError, label);
    assert.equal(m.state.created, 0, label);
    assert.equal(m.calls.length, 0, label);
    assert.equal(d.hashed.length, 0, label);
  }
});

test("an existing admin is left completely unchanged: looked up only, password not even hashed", async () => {
  for (const env of [{ DATABASE_URL: LOCAL }, { NODE_ENV: "production", DATABASE_URL: REMOTE }]) {
    const m = makeMock({ id: "u1", role: "ADMIN" });
    const d = makeDeps();
    const out = await runSeed({ ...env, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: STRONG }, m.factory, d.deps);
    assert.equal(out.adminCreated, false);
    assert.deepEqual(m.calls.filter((c) => c.model === "user").map((c) => c.op), ["findUnique"]);
    assert.equal(m.writes().length, 0);
    assert.equal(d.hashed.length, 0);
    assert.ok(d.lines.some((l) => /already exists — left unchanged/.test(l)));
  }
});

test("an existing NON-admin user with the admin email is not promoted or modified", async () => {
  const m = makeMock({ id: "u2", role: "CUSTOMER" });
  const d = makeDeps();
  const out = await runSeed({ NODE_ENV: "production", DATABASE_URL: REMOTE, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: STRONG }, m.factory, d.deps);
  assert.equal(out.adminCreated, false);
  assert.equal(m.writes().length, 0);
  assert.ok(d.lines.some((l) => /NOT promoted/.test(l)));
});

test("passwords, secrets and database credentials are never logged", async () => {
  for (const env of [
    { DATABASE_URL: LOCAL, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: STRONG },
    { NODE_ENV: "production", DATABASE_URL: REMOTE, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: STRONG },
  ]) {
    const d = makeDeps();
    await runSeed(env, makeMock().factory, d.deps);
    const text = d.lines.join("\n");
    for (const s of [STRONG, "dbpass-SECRET", env.DATABASE_URL]) assert.ok(!text.includes(s), `log leaked a secret: ${s.slice(0, 4)}…`);
  }
  try {
    await runSeed({ DATABASE_URL: REMOTE, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: "hunter2-secret" }, makeMock().factory, makeDeps().deps);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof SeedConfigError);
    const text = e.errors.join("\n") + e.message;
    for (const s of ["hunter2-secret", "dbpass-SECRET", REMOTE]) assert.ok(!text.includes(s));
  }
});

test("the client is disconnected even when seeding throws", async () => {
  let disconnected = 0;
  const client = {
    user: { findUnique: async () => { throw new Error("boom"); } },
    $disconnect: async () => void disconnected++,
  } as unknown as PrismaClient;
  await assert.rejects(runSeed({ DATABASE_URL: LOCAL, SEED_ADMIN_EMAIL: OWNER, SEED_ADMIN_PASSWORD: STRONG }, () => client, makeDeps().deps), /boom/);
  assert.equal(disconnected, 1);
});
