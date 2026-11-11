/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  fraudCheckSettings,
  fraudCheckStatus,
  fraudSource,
  isPhoneVerified,
  lookupFraudCheck,
  resetFraudCheckStateForTests,
  setFraudCheckClockForTests,
  setFraudCheckProviderForTests,
  type FraudCheckProvider,
} from "../../src/server/services/fraud-check.service";
import type { FraudCheckHistory } from "../../src/lib/advance-policy";

/**
 * The provider here is a STAND-IN that exists only inside these tests: it proves OUR mapping, validation, caching, de-duplication, budget and
 * failure handling. It says nothing about any real provider's behaviour (no real provider is integrated: see HANDOFF_GIFTPACIFIC.md §17).
 */
const KEYS = ["FRAUD_CHECK_ENABLED", "FRAUD_CHECK_PROVIDER", "FRAUD_CHECK_API_KEY", "FRAUD_CHECK_API_BASE_URL", "FRAUD_CHECK_TIMEOUT_MS", "FRAUD_CHECK_CACHE_SECONDS", "FRAUD_CHECK_MAX_CALLS_PER_MINUTE"];
const saved: Record<string, string | undefined> = {};
let clock = 1_800_000_000_000;
let calls: string[] = [];
let answer: () => Promise<unknown> = async () => ({ delivered: 0, cancelled: 0 });

const stub: FraudCheckProvider = {
  key: "test-stand-in",
  check: async (phone) => { calls.push(phone); return (await answer()) as FraudCheckHistory; },
};

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  clock = 1_800_000_000_000;
  calls = [];
  answer = async () => ({ delivered: 0, cancelled: 0 });
  setFraudCheckClockForTests(() => clock);
  setFraudCheckProviderForTests(stub);
  resetFraudCheckStateForTests();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setFraudCheckClockForTests(undefined);
  setFraudCheckProviderForTests(undefined);
  resetFraudCheckStateForTests();
});

const PHONE = "01711000000";

// ---- phone handling -------------------------------------------------------------------------------------------------------------------------
test("a missing or non-Bangladesh phone is unavailable (invalid_phone) and the provider is never called", async () => {
  for (const bad of [null, undefined, "", "abc", "12345", "01211000000", "+8802711000000"]) {
    const r = await lookupFraudCheck(bad);
    assert.deepEqual([r.status, (r as any).reason, r.cached], ["unavailable", "invalid_phone", false]);
  }
  assert.equal(calls.length, 0);
});

test("every accepted Bangladesh format reaches the provider as 01XXXXXXXXX", async () => {
  for (const f of ["01711000000", "8801711000000", "+8801711000000", "008801711000000", "+88 01711-000 000"]) {
    resetFraudCheckStateForTests();
    await lookupFraudCheck(f);
  }
  assert.deepEqual(calls, Array(5).fill(PHONE));
});

// ---- mapping a provider answer ------------------------------------------------------------------------------------------------------------
test("a real answer is mapped to the existing history shape, marked as provider data, and time-stamped", async () => {
  answer = async () => ({ delivered: 3, cancelled: 1, returned: 2, total: 7 });
  const r = await lookupFraudCheck(PHONE);
  assert.equal(r.status, "ok");
  assert.deepEqual((r as any).history, { delivered: 3, cancelled: 1, returned: 2, total: 7 });
  assert.equal((r as any).provider, "test-stand-in");
  assert.equal(fraudSource(r), "provider");
  assert.equal(new Date(r.checkedAt).toISOString(), r.checkedAt);
  assert.equal(r.cached, false);
});

test("optional fields stay optional: only delivered and cancelled are required", async () => {
  answer = async () => ({ delivered: 2, cancelled: 0 });
  const r = await lookupFraudCheck(PHONE);
  assert.deepEqual((r as any).history, { delivered: 2, cancelled: 0 });
});

test("no parcel history at all is 'no_history' (a real answer), not a failure", async () => {
  answer = async () => ({ delivered: 0, cancelled: 0, returned: 0, total: 0 });
  const r = await lookupFraudCheck(PHONE);
  assert.deepEqual([r.status, fraudSource(r)], ["no_history", "provider"]);
});

test("invalid or incomplete provider answers become unavailable (invalid_response); nothing from them is used", async () => {
  const bad: unknown[] = [null, undefined, "ok", 5, {}, { delivered: 2 }, { cancelled: 1 }, { delivered: "2", cancelled: 0 }, { delivered: -1, cancelled: 0 }, { delivered: 1.5, cancelled: 0 }, { delivered: 1, cancelled: 0, total: 0 }, { delivered: 1, cancelled: 0, returned: -2 }];
  for (const b of bad) {
    resetFraudCheckStateForTests();
    answer = async () => b;
    const r = await lookupFraudCheck(PHONE);
    assert.deepEqual([r.status, (r as any).reason, fraudSource(r)], ["unavailable", "invalid_response", "fallback"], JSON.stringify(b));
  }
});

test("a provider error is unavailable (error), never an exception", async () => {
  answer = async () => { throw new Error("boom: secret-token-123"); };
  const r = await lookupFraudCheck(PHONE);
  assert.deepEqual([r.status, (r as any).reason], ["unavailable", "error"]);
});

test("a provider that never answers times out at the configured limit", async () => {
  process.env.FRAUD_CHECK_TIMEOUT_MS = "500";
  answer = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await lookupFraudCheck(PHONE);
  assert.deepEqual([r.status, (r as any).reason], ["unavailable", "timeout"]);
  assert.ok(Date.now() - t0 < 2500);
});

// ---- switches ------------------------------------------------------------------------------------------------------------------------------
test("no provider configured, or the check switched off, never calls anything and says so", async () => {
  setFraudCheckProviderForTests(null);
  assert.equal(((await lookupFraudCheck(PHONE)) as any).reason, "no_provider");
  setFraudCheckProviderForTests(stub);
  process.env.FRAUD_CHECK_ENABLED = "false";
  assert.equal(((await lookupFraudCheck(PHONE)) as any).reason, "disabled");
  assert.equal(calls.length, 0);
  assert.deepEqual([fraudCheckStatus().enabled, fraudCheckStatus().configured], [false, false]);
});

test("an unknown FRAUD_CHECK_PROVIDER value has no adapter: unavailable (no_provider)", async () => {
  setFraudCheckProviderForTests(undefined);
  process.env.FRAUD_CHECK_PROVIDER = "some-provider";
  const r = await lookupFraudCheck(PHONE);
  assert.deepEqual([r.status, (r as any).reason], ["unavailable", "no_provider"]);
});

test("configuration is clamped to safe ranges and bad values fall back to the defaults", () => {
  const read = (name: string, v: string | undefined) => { if (v === undefined) delete process.env[name]; else process.env[name] = v; return fraudCheckSettings(); };
  assert.equal(read("FRAUD_CHECK_TIMEOUT_MS", undefined).timeoutMs, 3000);
  assert.equal(read("FRAUD_CHECK_TIMEOUT_MS", "abc").timeoutMs, 3000);
  assert.equal(read("FRAUD_CHECK_TIMEOUT_MS", "50").timeoutMs, 500);
  assert.equal(read("FRAUD_CHECK_TIMEOUT_MS", "999999").timeoutMs, 10_000);
  assert.equal(read("FRAUD_CHECK_CACHE_SECONDS", undefined).cacheSeconds, 600);
  assert.equal(read("FRAUD_CHECK_CACHE_SECONDS", "-5").cacheSeconds, 0);
  assert.equal(read("FRAUD_CHECK_CACHE_SECONDS", "99999999").cacheSeconds, 86_400);   // a result can never be served indefinitely
  assert.equal(read("FRAUD_CHECK_MAX_CALLS_PER_MINUTE", "0").maxCallsPerMinute, 1);
});

// ---- cache and de-duplication -------------------------------------------------------------------------------------------------------------
test("the same phone is answered from the cache until it expires, then asked again", async () => {
  process.env.FRAUD_CHECK_CACHE_SECONDS = "120";
  answer = async () => ({ delivered: 1, cancelled: 0 });
  const first = await lookupFraudCheck(PHONE);
  const second = await lookupFraudCheck("+8801711000000");          // another spelling of the same phone
  assert.deepEqual([first.cached, second.cached, calls.length], [false, true, 1]);
  assert.equal(second.checkedAt, first.checkedAt);                    // the original check time is kept
  clock += 119_000;
  assert.equal((await lookupFraudCheck(PHONE)).cached, true);
  clock += 2_000;                                                      // 121 s: expired
  const third = await lookupFraudCheck(PHONE);
  assert.deepEqual([third.cached, calls.length], [false, 2]);
});

test("a cache duration of 0 disables caching; a manual recheck (fresh) always asks again", async () => {
  process.env.FRAUD_CHECK_CACHE_SECONDS = "0";
  await lookupFraudCheck(PHONE); await lookupFraudCheck(PHONE);
  assert.equal(calls.length, 2);
  process.env.FRAUD_CHECK_CACHE_SECONDS = "600";
  resetFraudCheckStateForTests(); calls = [];
  await lookupFraudCheck(PHONE);
  await lookupFraudCheck(PHONE, { fresh: true });
  assert.equal(calls.length, 2);
  assert.equal((await lookupFraudCheck(PHONE)).cached, true);        // and the fresh answer refreshed the cache
});

test("with caching switched off, failures are not remembered either; a short cache time also caps how long a failure is remembered", async () => {
  answer = async () => { throw new Error("down"); };
  process.env.FRAUD_CHECK_CACHE_SECONDS = "0";
  await lookupFraudCheck(PHONE); await lookupFraudCheck(PHONE);
  assert.equal(calls.length, 2);
  process.env.FRAUD_CHECK_CACHE_SECONDS = "10";
  resetFraudCheckStateForTests(); calls = [];
  await lookupFraudCheck(PHONE);
  clock += 11_000;
  await lookupFraudCheck(PHONE);
  assert.equal(calls.length, 2);                                       // remembered 10 s (the cache time), not 30 s
});

test("different phones never share a cached result", async () => {
  answer = async () => ({ delivered: 1, cancelled: 0 });
  await lookupFraudCheck("01711000001"); await lookupFraudCheck("01711000002");
  assert.deepEqual(calls, ["01711000001", "01711000002"]);
});

test("failures are remembered for only 30 seconds, so a struggling provider is not hammered and a recovered one is used again", async () => {
  answer = async () => { throw new Error("down"); };
  assert.equal(((await lookupFraudCheck(PHONE)) as any).reason, "error");
  const again = await lookupFraudCheck(PHONE);
  assert.deepEqual([(again as any).reason, again.cached, calls.length], ["error", true, 1]);
  clock += 31_000;
  answer = async () => ({ delivered: 1, cancelled: 0 });
  const recovered = await lookupFraudCheck(PHONE);
  assert.deepEqual([recovered.status, recovered.cached, calls.length], ["ok", false, 2]);
});

test("simultaneous lookups for one phone share a single provider call", async () => {
  let release: (v: unknown) => void = () => {};
  answer = () => new Promise((r) => { release = r; });
  const pending = Array.from({ length: 6 }, () => lookupFraudCheck(PHONE));
  await new Promise((r) => setTimeout(r, 10));
  release({ delivered: 2, cancelled: 1 });
  const results = await Promise.all(pending);
  assert.equal(calls.length, 1);
  assert.equal(new Set(results.map((r) => JSON.stringify((r as any).history))).size, 1);
});

// ---- call budget ----------------------------------------------------------------------------------------------------------------------------
test("the per-minute call budget turns excess lookups into the fallback (rate_limited), is never cached, and refills", async () => {
  process.env.FRAUD_CHECK_MAX_CALLS_PER_MINUTE = "2";
  answer = async () => ({ delivered: 1, cancelled: 0 });
  assert.equal((await lookupFraudCheck("01711000001")).status, "ok");
  assert.equal((await lookupFraudCheck("01711000002")).status, "ok");
  const over = await lookupFraudCheck("01711000003");
  assert.deepEqual([over.status, (over as any).reason, fraudSource(over)], ["unavailable", "rate_limited", "fallback"]);
  assert.equal(calls.length, 2);
  assert.equal(((await lookupFraudCheck("01711000003")) as any).reason, "rate_limited");   // not remembered as an answer
  assert.equal((await lookupFraudCheck("01711000001")).cached, true);                      // cached phones need no budget
  clock += 61_000;
  assert.equal((await lookupFraudCheck("01711000003")).status, "ok");
});

// ---- secrecy --------------------------------------------------------------------------------------------------------------------------------
test("neither the phone number nor the credential is ever logged or exposed in the admin status", async () => {
  process.env.FRAUD_CHECK_API_KEY = "super-secret-key-abc123";
  const out: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = ((...a: unknown[]) => { out.push(a.map(String).join(" ")); }) as never;
  try {
    answer = async () => { throw new Error(`failed for ${PHONE} with super-secret-key-abc123`); };
    await lookupFraudCheck(PHONE);
    answer = () => new Promise(() => {}); process.env.FRAUD_CHECK_TIMEOUT_MS = "500"; resetFraudCheckStateForTests();
    await lookupFraudCheck(PHONE);
    answer = async () => ({ delivered: "x" }); resetFraudCheckStateForTests();
    await lookupFraudCheck(PHONE);
  } finally { Object.assign(console, orig); }
  assert.ok(out.length >= 3, "failures should be logged");
  const all = out.join("\n");
  assert.ok(!all.includes(PHONE) && !all.includes("1711000000") && !all.includes("super-secret-key-abc123"), all);
  const status = JSON.stringify(fraudCheckStatus());
  assert.ok(!status.includes("super-secret-key-abc123"));
  assert.equal(fraudCheckStatus().hasCredentials, true);
});

test("delivered history is not credited: no verified-phone mechanism exists", () => {
  assert.equal(isPhoneVerified(), false);
});

test("provider credentials can never reach the browser: no NEXT_PUBLIC_ variant, and no client component imports the service", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p); } };
  walk(path.join(process.cwd(), "src"));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/NEXT_PUBLIC_FRAUD/.test(text), `${f} exposes a fraud setting to the browser`);
    if (/^\s*["']use client["']/m.test(text)) {
      assert.ok(!/import\s+(?!type\b)[^;]*from\s+["']@\/server\/services\/fraud-check\.service["']/.test(text), `${f} is a client component that imports the fraud-check service`);
    }
  }
  assert.ok(!/NEXT_PUBLIC_FRAUD/.test(readFileSync(path.join(process.cwd(), ".env.example"), "utf8")));
});
