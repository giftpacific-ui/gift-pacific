/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeTrust, trustFromOutcome } from "../../src/lib/advance-policy";
import { FraudCheckProviderError, KNOWN_FRAUD_PROVIDERS } from "../../src/lib/fraud-check";
import { createSteadfastFraudProvider, mapSteadfastFraudBody, mapSteadfastFraudResult } from "../../src/server/services/fraud-providers/steadfast";
import {
  fraudCheckStatus,
  lookupFraudCheck,
  registeredFraudProviders,
  resetFraudCheckStateForTests,
  setFraudCheckClockForTests,
  setFraudCheckProviderForTests,
} from "../../src/server/services/fraud-check.service";

/**
 * The response examples are in tests/fixtures/steadfast-fraud-check/ and come from THIRD-PARTY descriptions, not from the official guide (see the
 * README there). `fetch` replacements exist only inside these tests: they prove OUR request building, mapping, validation and failure handling.
 * They say nothing about the live Steadfast service, which has never been called.
 */
const fixture = (name: string): any => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/steadfast-fraud-check", name), "utf8"));
const COUNTS = fixture("counts-and-ratios.json");
const RATIOS_ONLY = fixture("ratios-only.json");
const PHONE = "01712345678";
const KEY = "sf-key-DISTINCT-123";
const SECRET = "sf-secret-DISTINCT-456";
const BASE = "https://portal.packzy.com/api/v1";

const reasonOf = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof FraudCheckProviderError ? e.reason : `other:${String(e)}`; } };

// ---- the pure mapping --------------------------------------------------------------------------------------------------------------------------
test("exact integer counts are mapped to delivered / cancelled and nothing else; the volume range is not a total", () => {
  const h = mapSteadfastFraudBody(COUNTS, PHONE);
  assert.deepEqual(h, { delivered: 58, cancelled: 5 });
  assert.equal("total" in h, false);
  assert.equal("returned" in h, false);
});

test("a counts-free answer (percentages and bands only) is 'no_counts': nothing is estimated from a ratio or a band", () => {
  assert.equal(reasonOf(() => mapSteadfastFraudBody(RATIOS_ONLY, PHONE)), "no_counts");
  for (const band of ["none", "low", "medium", "high", "very_high"]) {
    for (const ratios of [{ delivery_ratio: 100, cancellation_ratio: 0 }, { delivery_ratio: 0, cancellation_ratio: 100 }, { delivery_ratio: null, cancellation_ratio: null }]) {
      assert.equal(reasonOf(() => mapSteadfastFraudBody({ ...RATIOS_ONLY, ...ratios, volume_band: band }, PHONE)), "no_counts", `${band} ${JSON.stringify(ratios)}`);
    }
  }
  assert.equal(reasonOf(() => mapSteadfastFraudBody({ ...COUNTS, delivered_count: undefined }, PHONE)), "no_counts");
  assert.equal(reasonOf(() => mapSteadfastFraudBody({ ...COUNTS, cancelled_count: null }, PHONE)), "no_counts");
  const { delivered_count: _d, cancelled_count: _c, ...noCounts } = COUNTS; void _d; void _c;
  assert.equal(reasonOf(() => mapSteadfastFraudBody(noCounts, PHONE)), "no_counts");
});

test("counts that are present but not whole non-negative numbers make the answer invalid", () => {
  for (const bad of ["58", "", -1, 5.5, Number.POSITIVE_INFINITY, true, [], {}, "NaN"]) {
    assert.equal(reasonOf(() => mapSteadfastFraudBody({ ...COUNTS, delivered_count: bad }, PHONE)), "invalid_response", `delivered ${String(bad)}`);
    assert.equal(reasonOf(() => mapSteadfastFraudBody({ ...COUNTS, cancelled_count: bad }, PHONE)), "invalid_response", `cancelled ${String(bad)}`);
  }
});

test("no parcel history: zero counts map to zero counts (the service reports 'no_history')", () => {
  assert.deepEqual(mapSteadfastFraudBody({ ...COUNTS, delivered_count: 0, cancelled_count: 0 }, PHONE), { delivered: 0, cancelled: 0 });
});

test("a body that carries a non-200 status is a failure, never a result", () => {
  for (const [status, reason] of [[401, "auth_failed"], [403, "auth_failed"], [429, "rate_limited"], [400, "error"], [404, "error"], [500, "error"]] as const) {
    assert.equal(reasonOf(() => mapSteadfastFraudBody({ ...COUNTS, status }, PHONE)), reason, String(status));
  }
  assert.doesNotThrow(() => mapSteadfastFraudBody({ ...COUNTS, status: 200 }, PHONE));
  assert.doesNotThrow(() => mapSteadfastFraudBody({ ...COUNTS, status: undefined }, PHONE));
});

test("an answer about a different phone number is rejected; other spellings of the same number and unparseable echoes are fine", () => {
  assert.equal(reasonOf(() => mapSteadfastFraudBody({ ...COUNTS, phone: "01912345678" }, PHONE)), "invalid_response");
  for (const same of ["01712345678", "+8801712345678", "8801712345678", "017-1234 5678", "017****5678", "", 42]) {
    assert.doesNotThrow(() => mapSteadfastFraudBody({ ...COUNTS, phone: same }, PHONE), String(same));
  }
});

test("bodies that are not JSON objects are invalid", () => {
  for (const body of [null, undefined, [], [COUNTS], "text", 5, true]) assert.equal(reasonOf(() => mapSteadfastFraudBody(body, PHONE)), "invalid_response", JSON.stringify(body));
});

test("transport results map to typed failures", () => {
  const r = (x: any) => reasonOf(() => mapSteadfastFraudResult(x, PHONE));
  assert.equal(r({ kind: "http_error", status: 401, json: null }), "auth_failed");
  assert.equal(r({ kind: "http_error", status: 403, json: { message: "Forbidden" } }), "auth_failed");
  assert.equal(r({ kind: "http_error", status: 429, json: null }), "rate_limited");
  for (const status of [400, 404, 418, 500, 502, 503]) assert.equal(r({ kind: "http_error", status, json: null }), "error", String(status));
  assert.equal(r({ kind: "invalid_response", status: 200 }), "invalid_response");
  assert.equal(r({ kind: "network", message: "The courier did not answer in time." }), "timeout");
  assert.equal(r({ kind: "network", message: "Could not reach the courier." }), "error");
  assert.deepEqual(mapSteadfastFraudResult({ kind: "ok", status: 200, json: COUNTS }, PHONE), { delivered: 58, cancelled: 5 });
});

test("a provider failure carries only a reason code (no URL, phone, credential or provider text)", () => {
  const e = new FraudCheckProviderError("auth_failed");
  assert.deepEqual([e.message, e.reason, Object.keys(e).sort()], ["auth_failed", "auth_failed", ["name", "reason"]]);   // only the class name and the reason code
});

// ---- the existing score formula is untouched ---------------------------------------------------------------------------------------------------
test("Steadfast counts feed the unchanged Phase 7.3 formula: delivered earns nothing for an unverified phone; cancelled lowers the score", () => {
  assert.equal(computeTrust({ delivered: 58, cancelled: 0 }).score, 50);
  assert.equal(computeTrust({ delivered: 58, cancelled: 1 }).score, 30);
  assert.equal(computeTrust({ delivered: 58, cancelled: 5 }).score, 0);
  assert.equal(computeTrust({ delivered: 58, cancelled: 5 }, { phoneVerified: true }).score, 0);
  assert.equal(computeTrust({ delivered: 5, cancelled: 0 }, { phoneVerified: true }).score, 100);
  for (const reason of ["auth_failed", "no_counts"] as const) {
    const t = trustFromOutcome({ status: "unavailable", reason }, { phoneVerified: true });
    assert.deepEqual([t.score, t.insufficientEvidence], [50, true]);
    assert.match(t.reasons.join(" "), /standard advance rule applies/);
  }
});

// ---- the factory: credentials are reused, never duplicated -----------------------------------------------------------------------------------
const CFG = { apiKey: null, baseUrl: null, timeoutMs: 2500 };
const make = (env: Record<string, string | undefined>, request?: any) => createSteadfastFraudProvider(CFG, { env, request });

test("the adapter exists only when the Steadfast courier credentials are complete, enabled and valid", () => {
  assert.equal(make({}), null);
  assert.equal(make({ STEADFAST_API_KEY: KEY }), null);
  assert.equal(make({ STEADFAST_API_SECRET: SECRET }), null);
  assert.equal(make({ STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET, STEADFAST_ENABLED: "false" }), null);
  assert.equal(make({ STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET, STEADFAST_API_BASE_URL: "http://portal.packzy.com/api/v1" }), null);   // https only
  assert.equal(make({ FRAUD_CHECK_API_KEY: "separate-fraud-key", FRAUD_CHECK_PROVIDER: "steadfast" }), null);                                      // no fraud-specific credential can stand in
  assert.equal(make({ STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET })?.key, "steadfast");
  assert.equal(make({ COURIER_PROVIDER: "steadfast", COURIER_API_KEY: KEY, COURIER_API_SECRET: SECRET })?.key, "steadfast");                        // legacy courier variables still count
});

test("the request is GET {base}/fraud_check/score/{normalised phone} with the courier's Api-Key / Secret-Key headers and the fraud-check timeout", async () => {
  const seen: any[] = [];
  const provider = make({ STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET }, async (...args: unknown[]) => { seen.push(args); return { kind: "ok", status: 200, json: COUNTS }; })!;
  const h = await provider.check(PHONE, new AbortController().signal);
  assert.deepEqual(h, { delivered: 58, cancelled: 5 });
  const [url, init, timeout] = seen[0];
  assert.equal(url, `${BASE}/fraud_check/score/${PHONE}`);
  assert.deepEqual(init, { method: "GET", headers: { "Api-Key": KEY, "Secret-Key": SECRET } });                                                    // no body
  assert.equal(timeout, 2500);
});

test("STEADFAST_API_BASE_URL is honoured (trailing slashes trimmed; plain http only for localhost)", async () => {
  const urls: string[] = [];
  const request = async (u: string) => { urls.push(u); return { kind: "ok", status: 200, json: COUNTS }; };
  await make({ STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET, STEADFAST_API_BASE_URL: "https://example.test/api/v1//" }, request)!.check(PHONE, new AbortController().signal);
  await make({ STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET, STEADFAST_API_BASE_URL: "http://localhost:4010/api/v1" }, request)!.check(PHONE, new AbortController().signal);
  assert.deepEqual(urls, [`https://example.test/api/v1/fraud_check/score/${PHONE}`, `http://localhost:4010/api/v1/fraud_check/score/${PHONE}`]);
});

test("anything that is not a normalised Bangladesh mobile number never reaches the URL", async () => {
  let called = 0;
  const provider = make({ STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET }, async () => { called++; return { kind: "ok", status: 200, json: COUNTS }; })!;
  for (const bad of ["0171", "../etc/passwd", "01712345678/../x", "+8801712345678", "01212345678", "01712345678?x=1", ""]) {
    await assert.rejects(provider.check(bad, new AbortController().signal), (e: any) => e instanceof FraudCheckProviderError && e.reason === "error", bad);
  }
  assert.equal(called, 0);
});

test("the registry contains exactly the known providers, and inherited object properties are never treated as providers", async () => {
  assert.deepEqual(registeredFraudProviders(), [...KNOWN_FRAUD_PROVIDERS].sort());
  assert.deepEqual(registeredFraudProviders(), ["steadfast"]);
  const saved = process.env.FRAUD_CHECK_PROVIDER;
  setFraudCheckProviderForTests(undefined);
  try {
    for (const value of ["constructor", "__proto__", "toString", "hasOwnProperty", "STEADFASTX", "pathao"]) {
      process.env.FRAUD_CHECK_PROVIDER = value;
      resetFraudCheckStateForTests();
      const r = await lookupFraudCheck(PHONE);
      assert.deepEqual([r.status, (r as any).reason], ["unavailable", "no_provider"], value);
    }
  } finally { if (saved === undefined) delete process.env.FRAUD_CHECK_PROVIDER; else process.env.FRAUD_CHECK_PROVIDER = saved; }
});

// ---- through the real service with the real adapter (only `fetch` is replaced) -----------------------------------------------------------------
const ENV_KEYS = ["FRAUD_CHECK_PROVIDER", "FRAUD_CHECK_ENABLED", "FRAUD_CHECK_API_KEY", "FRAUD_CHECK_API_BASE_URL", "FRAUD_CHECK_TIMEOUT_MS", "FRAUD_CHECK_CACHE_SECONDS", "FRAUD_CHECK_MAX_CALLS_PER_MINUTE", "STEADFAST_API_KEY", "STEADFAST_API_SECRET", "STEADFAST_API_BASE_URL", "STEADFAST_ENABLED", "COURIER_PROVIDER", "COURIER_API_KEY", "COURIER_API_SECRET"];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let fetchCalls: { url: string; init: any }[] = [];
let respond: () => Promise<Response> = async () => Response.json(COUNTS);
let clock = 1_800_000_000_000;

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { FRAUD_CHECK_PROVIDER: "steadfast", FRAUD_CHECK_ENABLED: "true", STEADFAST_API_KEY: KEY, STEADFAST_API_SECRET: SECRET, STEADFAST_API_BASE_URL: BASE });
  fetchCalls = []; clock = 1_800_000_000_000;
  respond = async () => Response.json(COUNTS);
  globalThis.fetch = (async (url: string, init: any) => { fetchCalls.push({ url: String(url), init }); return respond(); }) as never;
  setFraudCheckProviderForTests(undefined);               // use the REAL registry
  setFraudCheckClockForTests(() => clock);
  resetFraudCheckStateForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = realFetch;
  setFraudCheckClockForTests(undefined);
  resetFraudCheckStateForTests();
});

test("end to end: FRAUD_CHECK_PROVIDER=steadfast + the courier credentials produce a real-adapter lookup with normalised phone and headers", async () => {
  const r = await lookupFraudCheck("+8801712345678");
  assert.equal(r.status, "ok");
  assert.deepEqual((r as any).history, { delivered: 58, cancelled: 5 });
  assert.equal((r as any).provider, "steadfast");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, `${BASE}/fraud_check/score/${PHONE}`);
  assert.equal(fetchCalls[0].init.method, "GET");
  assert.equal(fetchCalls[0].init.headers["Api-Key"], KEY);
  assert.equal(fetchCalls[0].init.headers["Secret-Key"], SECRET);
  assert.equal(fetchCalls[0].init.redirect, "error");                                           // credentials are never sent to a redirect target
  assert.equal(fetchCalls[0].init.body, undefined);
  assert.equal(process.env.FRAUD_CHECK_API_KEY, undefined);                                     // no fraud-specific credential was needed
});

test("end to end: the answer is cached, simultaneous lookups share one call, and the call budget still applies", async () => {
  await lookupFraudCheck(PHONE); const again = await lookupFraudCheck("01712345678");
  assert.deepEqual([again.cached, fetchCalls.length], [true, 1]);
  resetFraudCheckStateForTests(); fetchCalls = [];
  let release: () => void = () => {};
  respond = () => new Promise((res) => { release = () => res(Response.json(COUNTS)); });
  const many = Array.from({ length: 5 }, () => lookupFraudCheck(PHONE));
  await new Promise((r) => setTimeout(r, 10)); release();
  assert.equal((await Promise.all(many)).every((x) => x.status === "ok"), true);
  assert.equal(fetchCalls.length, 1);
  resetFraudCheckStateForTests(); fetchCalls = []; respond = async () => Response.json(COUNTS);
  process.env.FRAUD_CHECK_MAX_CALLS_PER_MINUTE = "1";
  await lookupFraudCheck("01711111111");
  assert.equal(((await lookupFraudCheck("01722222222")) as any).reason, "rate_limited");
  assert.equal(fetchCalls.length, 1);
});

test("end to end: no parcel history is 'no_history'; a ratios-only answer is unavailable (no_counts) with the fallback policy", async () => {
  respond = async () => Response.json({ ...COUNTS, delivered_count: 0, cancelled_count: 0 });
  assert.equal((await lookupFraudCheck(PHONE)).status, "no_history");
  resetFraudCheckStateForTests();
  respond = async () => Response.json(RATIOS_ONLY);
  const r = await lookupFraudCheck(PHONE);
  assert.deepEqual([r.status, (r as any).reason], ["unavailable", "no_counts"]);
  assert.deepEqual(trustFromOutcome(r, { phoneVerified: true }).score, 50);
});

test("end to end: every failure becomes the matching unavailable reason and never an exception", async () => {
  const cases: [string, () => Promise<Response>, string][] = [
    ["401", async () => new Response("{}", { status: 401 }), "auth_failed"],
    ["403", async () => new Response("{}", { status: 403 }), "auth_failed"],
    ["429", async () => new Response("{}", { status: 429 }), "rate_limited"],
    ["404", async () => new Response("{}", { status: 404 }), "error"],
    ["500 html", async () => new Response("<html>Bad gateway</html>", { status: 502 }), "error"],
    ["200 html", async () => new Response("<html>login</html>", { status: 200 }), "invalid_response"],
    ["200 empty", async () => new Response("", { status: 200 }), "invalid_response"],
    ["200 array", async () => Response.json([1, 2]), "invalid_response"],
    ["body 401", async () => Response.json({ status: 401, message: "Unauthorized" }), "auth_failed"],
    ["wrong phone", async () => Response.json({ ...COUNTS, phone: "01999999999" }), "invalid_response"],
    ["bad count", async () => Response.json({ ...COUNTS, cancelled_count: "five" }), "invalid_response"],
    ["network", async () => { throw new TypeError("fetch failed"); }, "error"],
  ];
  for (const [name, fn, reason] of cases) {
    resetFraudCheckStateForTests(); respond = fn;
    const r = await lookupFraudCheck(PHONE);
    assert.deepEqual([r.status, (r as any).reason], ["unavailable", reason], name);
  }
});

test("end to end: an answer that never arrives times out at the configured limit", async () => {
  process.env.FRAUD_CHECK_TIMEOUT_MS = "500";
  respond = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await lookupFraudCheck(PHONE);
  assert.deepEqual([r.status, (r as any).reason], ["unavailable", "timeout"]);
  assert.ok(Date.now() - t0 < 2500);
});

test("end to end: switches. Disabled, or courier credentials missing/switched off, never call the network and say why", async () => {
  process.env.FRAUD_CHECK_ENABLED = "false";
  assert.equal(((await lookupFraudCheck(PHONE)) as any).reason, "disabled");
  process.env.FRAUD_CHECK_ENABLED = "true"; process.env.STEADFAST_ENABLED = "false";
  assert.equal(((await lookupFraudCheck(PHONE)) as any).reason, "no_provider");
  delete process.env.STEADFAST_ENABLED; delete process.env.STEADFAST_API_SECRET;
  assert.equal(((await lookupFraudCheck(PHONE)) as any).reason, "no_provider");
  delete process.env.FRAUD_CHECK_PROVIDER; process.env.STEADFAST_API_SECRET = SECRET;
  assert.equal(((await lookupFraudCheck(PHONE)) as any).reason, "no_provider");
  assert.equal(fetchCalls.length, 0);
});

test("neither the credentials nor the phone number appear in any log, result or status", async () => {
  const out: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = ((...a: unknown[]) => { out.push(a.map(String).join(" ")); }) as never;
  const results: unknown[] = [];
  try {
    for (const fn of [async () => new Response("{}", { status: 401 }), async () => new Response("<html>", { status: 500 }), async () => { throw new TypeError(`fetch failed for ${PHONE} ${KEY} ${SECRET}`); }, async () => Response.json({ ...COUNTS, cancelled_count: "x" })]) {
      resetFraudCheckStateForTests(); respond = fn;
      results.push(await lookupFraudCheck(PHONE));
    }
  } finally { Object.assign(console, orig); }
  assert.ok(out.length >= 4, "failures should be logged");
  const everything = out.join("\n") + JSON.stringify(results) + JSON.stringify(fraudCheckStatus());
  for (const secret of [KEY, SECRET, PHONE, "1712345678"]) assert.ok(!everything.includes(secret), `leaked ${secret}`);
  assert.ok(out.join("\n").includes("auth_failed"));                                                  // the reason code is logged, nothing else
  const status = fraudCheckStatus();
  assert.deepEqual([status.provider, status.configured, status.hasCredentials], ["steadfast", true, true]);
  assert.match(String(status.credentialSource), /STEADFAST_API_KEY \/ STEADFAST_API_SECRET/);
});
