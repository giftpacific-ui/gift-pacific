/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { POST } from "@/app/api/consent/withdraw/route";

const REF = "R".repeat(22);
const realEnv = { ...process.env };
let db: FakeDb;

beforeEach(() => {
  db = freshDb(); seedAdmins(db); seedCatalog(db);
  process.env.RATE_LIMIT_ENABLED = "false";
  for (const [id, userId, ref] of [["o1", null, REF], ["o2", "cust", "S".repeat(22)], ["o3", "other", "T".repeat(22)]] as const) {
    db.insert("orderAttribution", { id: `a-${id}`, orderId: id, userId, consentRef: ref, consentState: "GRANTED", consentWithdrawnAt: null, fbp: "fb.1.1700000000000.1", clientIp: "203.0.113.7", gaClientId: "1.1", createdAt: new Date() });
    db.insert("trackingEventLog", { id: `l-${id}`, destination: "META_CAPI", eventName: "Purchase", eventId: `purchase_${id}`, orderId: id, orderNumber: id, status: "PENDING", attempts: 0, eventTime: new Date(), nextAttemptAt: new Date() });
  }
});
afterEach(() => { process.env = { ...realEnv }; });

const call = (body: unknown, headers: Record<string, string> = { origin: "https://shop.test" }, raw?: string) =>
  POST(new Request("https://shop.test/api/consent/withdraw", { method: "POST", headers, body: raw ?? JSON.stringify(body) }));
const state = (orderId: string) => ({ attr: db.rows("orderAttribution").find((r) => r.orderId === orderId)!, log: db.rows("trackingEventLog").find((r) => r.orderId === orderId)! });

test("guest: a valid reference stops that order's pending events; the response reveals nothing but { ok: true }", async () => {
  const res = await call({ ref: REF });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(state("o1").log.status, "SKIPPED");
  assert.equal(state("o1").log.skipReason, "consent_withdrawn");
  assert.equal(state("o1").attr.clientIp ?? null, null);
  assert.equal(state("o2").log.status, "PENDING", "other orders untouched");
  assert.equal(state("o3").log.status, "PENDING");
  // The same answer whether or not anything matched: no way to probe for existing references.
  const miss = await call({ ref: "Z".repeat(22) });
  assert.deepEqual([miss.status, await miss.json()], [200, { ok: true }]);
});

test("signed-in customer: withdrawal also covers their own orders (other devices, no reference), and only theirs", async () => {
  const res = await runAs({ sub: "cust" }, () => call({}));
  assert.equal(res.status, 200);
  assert.equal(state("o2").log.skipReason, "consent_withdrawn");
  assert.equal(state("o1").log.status, "PENDING");
  assert.equal(state("o3").log.status, "PENDING");
  // Reference + account together.
  db.patch("trackingEventLog", "l-o1", { status: "PENDING", skipReason: null });
  await runAs({ sub: "other" }, () => call({ ref: REF }));
  assert.equal(state("o1").log.status, "SKIPPED");
  assert.equal(state("o3").log.status, "SKIPPED");
});

test("anonymous with no reference: accepted, does nothing", async () => {
  const res = await call({});
  assert.equal(res.status, 200);
  assert.ok(db.rows("trackingEventLog").every((l) => l.status === "PENDING"));
  const empty = await call(undefined, { origin: "https://shop.test" }, "");
  assert.equal(empty.status, 200);
});

test("hardening: cross-origin 403, malformed reference / body 400, oversize 413; none of them change anything", async () => {
  assert.equal((await call({ ref: REF }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call({ ref: REF }, { origin: "not a url" })).status, 403);
  assert.equal((await call({ ref: "short" })).status, 400);
  assert.equal((await call({ ref: 123 })).status, 400);
  assert.equal((await call(undefined, { origin: "https://shop.test" }, "{not json")).status, 400);
  assert.equal((await call({ ref: REF, pad: "x".repeat(2000) })).status, 413);
  assert.ok(db.rows("trackingEventLog").every((l) => l.status === "PENDING"));
  // No Origin header (some non-browser clients) is allowed: the operation is fail-closed and needs the secret reference anyway.
  assert.equal((await call({ ref: REF }, {})).status, 200);
});

test("a server error answers 500 (not 200) so the browser keeps its pending marker and retries", async () => {
  const real = (globalThis as any).__TEST_DB__;
  (globalThis as any).__TEST_DB__ = new Proxy(real, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      return k === "orderAttribution" ? { ...v, findMany: async () => { throw new Error("db down"); } } : v;
    },
  });
  try {
    const res = await call({ ref: REF });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false });
  } finally { (globalThis as any).__TEST_DB__ = real; }
  assert.equal(state("o1").log.status, "PENDING");
});
