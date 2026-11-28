/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The courier intelligence service against the in-memory database. The adapter below is a STAND-IN defined in this file: these tests prove OUR
 * mapping, persistence, caching, budgets, authorisation and privacy rules. They say nothing about what the real Steadfast API returns, and the
 * in-memory database does not prove real locking or concurrency.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runAs, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import {
  getCourierIntelligence, getIntelligenceProviderStatuses, getStoredIntelligence, hashPhone, intelligenceSettings, isPhoneVerified, maskPhone,
  purgeIntelligenceSnapshots, resetIntelligenceStateForTests, setIntelligenceAdaptersForTests, setIntelligenceClockForTests,
} from "@/server/services/courier-intelligence.service";
import { adminCheckProvider } from "@/server/services/courier-intelligence-admin.service";
import { checkCourierProviderAction } from "@/server/actions/admin-courier-intelligence.actions";
import { EMPTY_METRICS } from "@/lib/courier-intelligence/types";
import type { HistoryAdapter } from "@/server/services/courier-intelligence-providers/steadfast";

let db: FakeDb;
let clock = 1_800_000_000_000;
let calls: string[] = [];
let answer: () => Promise<any>;
const KEYS = ["FRAUD_CHECK_ENABLED", "FRAUD_CHECK_PROVIDER", "FRAUD_CHECK_TIMEOUT_MS", "FRAUD_CHECK_CACHE_SECONDS", "FRAUD_CHECK_MAX_CALLS_PER_MINUTE", "COURIER_INTEL_RETENTION_DAYS", "RATE_LIMIT_ENABLED", "AUTH_SECRET"];
const saved: Record<string, string | undefined> = {};

const good = (delivered: number, cancelled: number, total = delivered + cancelled, fraudReports: number | null = 0) =>
  async () => ({ ok: true, metrics: { ...EMPTY_METRICS, delivered, cancelled, total, fraudReports, empty: total === 0 } });
const stub: HistoryAdapter = { key: "steadfast", lookup: async (phone) => { calls.push(phone); return answer(); } };

const PHONE = "01711000000";
const PHONE2 = "01811000000";
const rows = () => db.rows("courierIntelligenceSnapshot");

beforeEach(() => {
  db = freshDb();
  seedAdmins(db);
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.AUTH_SECRET = "test-secret-for-hashing-0123456789";
  clock = 1_800_000_000_000;
  calls = [];
  answer = good(9, 1);
  setIntelligenceClockForTests(() => clock);
  setIntelligenceAdaptersForTests({ steadfast: stub });
  resetIntelligenceStateForTests();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setIntelligenceClockForTests(undefined);
  setIntelligenceAdaptersForTests(undefined);
  resetIntelligenceStateForTests();
});

const ask = (phone: string | null = PHONE, o: { fresh?: boolean; maxAgeSeconds?: number } = {}) => getCourierIntelligence(phone, { source: "CHECKOUT", ...o });

// ---- phone handling --------------------------------------------------------------------------------------------------------------------------------
test("a missing or non-Bangladesh phone is invalid: no courier is called and nothing is stored", async () => {
  for (const bad of [null, undefined, "", "abc", "12345", "01211000000"]) {
    const r = await getCourierIntelligence(bad as any, { source: "CHECKOUT" });
    assert.deepEqual([r.phoneValid, r.phoneMasked, r.combined.state, r.combined.deliverySuccessRate], [false, null, "unavailable", null], String(bad));
    assert.ok(r.reports.every((x) => x.status === "unavailable" && x.reason === "invalid_phone"));
  }
  assert.deepEqual([calls.length, rows().length], [0, 0]);
});

test("every accepted Bangladesh format reaches the courier as 01XXXXXXXXX and is answered once", async () => {
  for (const p of ["01711000000", "+8801711000000", "8801711000000"]) { await ask(p, { fresh: true }); }
  assert.deepEqual(calls, [PHONE, PHONE, PHONE]);
});

// ---- mapping and persistence ---------------------------------------------------------------------------------------------------------------------------
test("a real answer is mapped, time-stamped, combined, and stored WITHOUT the raw phone number", async () => {
  const r = await ask();
  const s = r.reports.find((x) => x.provider === "steadfast")!;
  assert.deepEqual([s.status, s.delivered, s.cancelled, s.total, s.cached, s.checkedAt], ["ok", 9, 1, 10, false, new Date(clock).toISOString()]);
  assert.deepEqual([r.combined.state, r.combined.deliverySuccessRate, r.phoneMasked], ["valid", 90, "017*****000"]);
  assert.equal(rows().length, 1);
  const row = rows()[0];
  assert.equal(row.phoneHash, hashPhone(PHONE));
  assert.notEqual(row.phoneHash, PHONE);
  assert.equal(row.phoneMasked, "017*****000");
  assert.equal(row.source, "CHECKOUT");
  assert.ok(!JSON.stringify(row).includes(PHONE), "no raw phone anywhere in the stored row");
  assert.ok(!JSON.stringify(row).includes("1711000000"));
  assert.equal(maskPhone("0171100"), "***");
});

test("the hash is keyed (changes with the secret) and different numbers hash differently", () => {
  const a = hashPhone(PHONE);
  assert.notEqual(a, hashPhone(PHONE2));
  process.env.AUTH_SECRET = "another-secret-value-0123456789abc";
  assert.notEqual(a, hashPhone(PHONE));
});

test("no parcel history is 'no_history' (a real answer); parcels still in progress are history without outcomes", async () => {
  answer = good(0, 0, 0);
  const r = await ask();
  assert.deepEqual([r.reports[0].status, r.combined.state, r.combined.deliverySuccessRate], ["no_history", "no_history", null]);
  answer = good(0, 0, 3);
  const p = await ask(PHONE2);
  assert.deepEqual([p.reports[0].status, p.combined.state], ["ok", "no_history"]);
});

// ---- failures --------------------------------------------------------------------------------------------------------------------------------------
test("every failure is a typed 'unavailable' report, stored for diagnostics, never an exception", async () => {
  const failures: [() => Promise<any>, string][] = [
    [async () => ({ ok: false, reason: "auth_failed" }), "auth_failed"],
    [async () => ({ ok: false, reason: "rate_limited" }), "rate_limited"],
    [async () => ({ ok: false, reason: "invalid_response" }), "invalid_response"],
    [async () => { throw new Error("boom https://secret.example/01711000000"); }, "error"],
  ];
  let n = 0;
  for (const [fn, reason] of failures) {
    answer = fn;
    const r = await ask(`017110000${String(10 + n++)}`);
    const s = r.reports[0];
    assert.deepEqual([s.status, s.reason, r.combined.state, r.combined.deliverySuccessRate], ["unavailable", reason, "unavailable", null], reason);
  }
  assert.equal(rows().filter((r) => r.status === "unavailable").length, 4);
  assert.ok(rows().every((r) => r.delivered === null && r.cancelled === null)); // missing data is never stored as zero
});

test("a courier that never answers times out at the configured limit and the checkout carries on", async () => {
  process.env.FRAUD_CHECK_TIMEOUT_MS = "500";
  answer = () => new Promise(() => undefined);
  const t0 = Date.now();
  const r = await ask();
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual([r.reports[0].status, r.reports[0].reason], ["unavailable", "timeout"]);
});

// ---- capability and configuration -----------------------------------------------------------------------------------------------------------------
test("Pathao and REDX are 'unsupported': they are never called, even if someone injects an adapter, and they never block Steadfast", async () => {
  const trap: HistoryAdapter = { key: "steadfast", lookup: async (p) => { calls.push(`TRAP:${p}`); return good(50, 0)(); } };
  setIntelligenceAdaptersForTests({ steadfast: stub, pathao: trap as any, redx: trap as any });
  const r = await ask();
  assert.deepEqual(r.reports.map((x) => [x.provider, x.status]), [["steadfast", "ok"], ["pathao", "unsupported"], ["redx", "unsupported"]]);
  assert.deepEqual(calls, [PHONE]);
  assert.deepEqual(r.combined.excluded.map((e) => [e.provider, e.why]), [["pathao", "unsupported"], ["redx", "unsupported"]]);
  assert.equal(r.combined.deliverySuccessRate, 90);
  // an unsupported courier writes nothing
  assert.deepEqual([...new Set(rows().map((x) => x.provider))], ["steadfast"]);
});

test("missing Steadfast credentials: 'not_configured', no call, nothing stored, and the page/checkout still work", async () => {
  setIntelligenceAdaptersForTests({ steadfast: null });
  const r = await ask();
  assert.deepEqual([r.reports[0].status, r.combined.state, r.combined.deliverySuccessRate], ["not_configured", "unavailable", null]);
  assert.deepEqual([calls.length, rows().length], [0, 0]);
});

test("the check can be switched off (FRAUD_CHECK_ENABLED=false or FRAUD_CHECK_PROVIDER=none): nothing is called or stored", async () => {
  for (const [k, v] of [["FRAUD_CHECK_ENABLED", "false"], ["FRAUD_CHECK_PROVIDER", "none"]] as const) {
    process.env[k] = v;
    const r = await ask();
    assert.deepEqual([r.reports[0].status, r.reports[0].reason], ["unavailable", "disabled"], k);
    delete process.env[k];
  }
  assert.deepEqual([calls.length, rows().length], [0, 0]);
});

test("configuration is clamped to safe ranges and bad values fall back to the defaults", () => {
  const d = intelligenceSettings({});
  assert.deepEqual([d.enabled, d.timeoutMs, d.cacheSeconds, d.maxCallsPerMinute, d.retentionDays], [true, 3000, 600, 60, 90]);
  const hi = intelligenceSettings({ FRAUD_CHECK_TIMEOUT_MS: "999999", FRAUD_CHECK_CACHE_SECONDS: "999999", FRAUD_CHECK_MAX_CALLS_PER_MINUTE: "999999", COURIER_INTEL_RETENTION_DAYS: "99999" });
  assert.deepEqual([hi.timeoutMs, hi.cacheSeconds, hi.maxCallsPerMinute, hi.retentionDays], [10_000, 86_400, 1000, 730]);
  const lo = intelligenceSettings({ FRAUD_CHECK_TIMEOUT_MS: "1", FRAUD_CHECK_CACHE_SECONDS: "-5", FRAUD_CHECK_MAX_CALLS_PER_MINUTE: "0", COURIER_INTEL_RETENTION_DAYS: "1" });
  assert.deepEqual([lo.timeoutMs, lo.cacheSeconds, lo.maxCallsPerMinute, lo.retentionDays], [500, 0, 1, 7]);
  const junk = intelligenceSettings({ FRAUD_CHECK_TIMEOUT_MS: "abc", FRAUD_CHECK_CACHE_SECONDS: "1.5", FRAUD_CHECK_ENABLED: "FALSE" });
  assert.deepEqual([junk.timeoutMs, junk.cacheSeconds, junk.enabled], [3000, 600, false]);
});

// ---- cache, freshness, history ---------------------------------------------------------------------------------------------------------------------
test("the same phone is answered from the shared cache until it expires, then asked again", async () => {
  process.env.FRAUD_CHECK_CACHE_SECONDS = "60";
  const a = await ask();
  clock += 30_000;
  const b = await ask();
  assert.deepEqual([calls.length, a.reports[0].cached, b.reports[0].cached, b.reports[0].checkedAt], [1, false, true, a.reports[0].checkedAt]);
  clock += 31_000; // 61 s after the first answer
  const c = await ask();
  assert.deepEqual([calls.length, c.reports[0].cached], [2, false]);
});

test("a cache of 0 serves nothing, yet every answer is still kept as history; a manual refresh always asks again and ADDS a row", async () => {
  process.env.FRAUD_CHECK_CACHE_SECONDS = "0";
  await ask(); await ask();
  assert.deepEqual([calls.length, rows().length], [2, 2]);
  process.env.FRAUD_CHECK_CACHE_SECONDS = "600";
  clock += 1000;
  await ask(PHONE, { fresh: true });
  await ask(PHONE, { fresh: true });
  assert.equal(calls.length, 4);
  clock += 1000;
  const cached = await ask(PHONE);
  assert.equal(calls.length, 4); // served from the newest saved answer: no fifth call
  assert.equal(cached.reports[0].cached, true);
  assert.equal(rows().length, 4); // earlier results are preserved, never overwritten
});

test("a checkout never relies on evidence older than the policy allows, even if the cache would still serve it", async () => {
  process.env.FRAUD_CHECK_CACHE_SECONDS = "3600";
  await ask();
  clock += 120_000;
  assert.equal((await ask(PHONE, { maxAgeSeconds: 300 })).reports[0].cached, true);
  assert.equal(calls.length, 1);
  clock += 400_000;
  assert.equal((await ask(PHONE, { maxAgeSeconds: 300 })).reports[0].cached, false);
  assert.equal(calls.length, 2);
});

test("different phones never share a cached result", async () => {
  await ask(PHONE); await ask(PHONE2);
  assert.deepEqual(calls, [PHONE, PHONE2]);
  assert.notEqual(rows()[0].phoneHash, rows()[1].phoneHash);
});

test("failures are remembered for only 30 seconds (never longer than the cache), so a struggling courier is not hammered and a recovered one is used again", async () => {
  process.env.FRAUD_CHECK_CACHE_SECONDS = "600";
  answer = async () => ({ ok: false, reason: "error" });
  await ask();
  clock += 10_000;
  const again = await ask();
  assert.deepEqual([calls.length, again.reports[0].cached, again.reports[0].status], [1, true, "unavailable"]);
  clock += 25_000; // 35 s: forgotten
  answer = good(4, 0);
  const recovered = await ask();
  assert.deepEqual([calls.length, recovered.reports[0].status], [2, "ok"]);
  // a short cache caps the failure memory too
  process.env.FRAUD_CHECK_CACHE_SECONDS = "5";
  answer = async () => ({ ok: false, reason: "timeout" });
  await ask(PHONE2);
  clock += 6000;
  await ask(PHONE2);
  assert.equal(calls.length, 4);
});

test("simultaneous lookups for one phone share a single courier call", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  answer = async () => { await gate; return good(3, 0)(); };
  const all = Promise.all([1, 2, 3, 4, 5].map(() => ask()));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const out = await all;
  assert.equal(calls.length, 1);
  assert.ok(out.every((r) => r.reports[0].status === "ok"));
  assert.equal(rows().length, 1);
});

test("the per-courier call budget (database-backed) turns excess lookups into 'rate_limited', is never stored, and refills", async () => {
  process.env.FRAUD_CHECK_MAX_CALLS_PER_MINUTE = "2";
  const phones = ["01711000001", "01711000002", "01711000003", "01711000004"];
  const out = [];
  for (const p of phones.slice(0, 3)) out.push(await ask(p));
  assert.deepEqual(out.map((r) => r.reports[0].status), ["ok", "ok", "unavailable"]);
  assert.equal(out[2].reports[0].reason, "rate_limited");
  assert.equal(calls.length, 2);
  assert.equal(rows().length, 2); // a refusal says nothing about the courier: not stored
  clock += 61_000;
  assert.equal((await ask(phones[3])).reports[0].status, "ok");
});

// ---- stored view, retention ------------------------------------------------------------------------------------------------------------------------
test("opening a stored view never calls a courier; a never-checked phone lists the courier as 'unchecked' (not a failure, not zero)", async () => {
  const none = await getStoredIntelligence(PHONE);
  assert.deepEqual([none.unchecked, calls.length, none.combined.state], [["steadfast"], 0, "unavailable"]);
  assert.deepEqual(none.reports.map((r) => [r.provider, r.status]), [["pathao", "unsupported"], ["redx", "unsupported"]]);
  await ask();
  clock += 5 * 3600_000; // long after the cache expired: still shown, with its age
  const seen = await getStoredIntelligence(PHONE);
  assert.deepEqual([calls.length, seen.unchecked, seen.combined.deliverySuccessRate, seen.reports[0].checkedAt], [1, [], 90, new Date(1_800_000_000_000).toISOString()]);
  assert.equal((await getStoredIntelligence("abc")).phoneValid, false);
  setIntelligenceAdaptersForTests({ steadfast: null });
  assert.equal((await getStoredIntelligence(PHONE)).reports[0].status, "not_configured");
});

test("retention: saved lookups older than the retention period are deleted; recent ones stay", async () => {
  await ask(PHONE);
  clock += 100 * 86_400_000;
  await ask(PHONE2);
  const deleted = await purgeIntelligenceSnapshots(new Date(clock));
  assert.equal(deleted, 1);
  assert.deepEqual(rows().map((r) => r.phoneMasked), ["018*****000"]);
});

// ---- privacy ---------------------------------------------------------------------------------------------------------------------------------------
test("neither the full phone number nor any credential is ever logged, stored or exposed in provider status", async () => {
  const lines: string[] = [];
  const orig = { w: console.warn, e: console.error, i: console.info, l: console.log };
  console.warn = console.error = console.info = console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    answer = async () => ({ ok: false, reason: "auth_failed" });
    await ask();
    answer = async () => { throw new Error("secret SEC-123456 for 01711000000"); };
    await ask(PHONE2, { fresh: true });
    process.env.FRAUD_CHECK_MAX_CALLS_PER_MINUTE = "1";
    await ask("01911000000");
    await ask("01911000001");
  } finally { console.warn = orig.w; console.error = orig.e; console.info = orig.i; console.log = orig.l; }
  const text = lines.join("\n");
  assert.ok(lines.length > 0);
  for (const raw of [PHONE, PHONE2, "01911000000", "01911000001", "SEC-123456", "KEY-abcdef"]) assert.ok(!text.includes(raw), `${raw} leaked into logs`);
  assert.ok(text.includes("017*****000")); // masked form only
  const status = JSON.stringify(await getIntelligenceProviderStatuses({ STEADFAST_ENABLED: "true", STEADFAST_API_KEY: "KEY-abcdef", STEADFAST_API_SECRET: "SEC-123456" }));
  for (const secret of ["KEY-abcdef", "SEC-123456"]) assert.ok(!status.includes(secret));
});

test("there is no verified-phone mechanism: isPhoneVerified is false (a profile phone is free text)", () => {
  assert.equal(isPhoneVerified(), false);
});

// ---- provider status honesty ----------------------------------------------------------------------------------------------------------------------
test("provider status: credentials alone are 'configured, not yet verified'; only a recorded successful lookup is 'connected'; a newer failure is 'error'", async () => {
  const env = { STEADFAST_ENABLED: "true", STEADFAST_API_KEY: "KEY-abcdef", STEADFAST_API_SECRET: "SEC-123456" };
  const st = async () => (await getIntelligenceProviderStatuses(env)).find((p) => p.key === "steadfast")!;
  assert.equal((await st()).state, "configured_unverified");
  assert.equal((await st()).bookingConfigured, true);
  await ask();
  const connected = await st();
  assert.deepEqual([connected.state, connected.lastSuccessAt], ["connected", new Date(clock).toISOString()]);
  clock += 60_000;
  answer = async () => ({ ok: false, reason: "auth_failed" });
  await ask(PHONE, { fresh: true });
  const err = await st();
  assert.deepEqual([err.state, err.lastFailureReason], ["error", "auth_failed"]);
  clock += 60_000;
  answer = good(1, 0);
  await ask(PHONE, { fresh: true });
  assert.equal((await st()).state, "connected");
});

test("provider status: not configured / off / unsupported are reported as such; booking credentials are a separate fact", async () => {
  setIntelligenceAdaptersForTests({ steadfast: null });
  const all = await getIntelligenceProviderStatuses({});
  assert.deepEqual(all.map((p) => [p.key, p.state]), [["steadfast", "not_configured"], ["pathao", "unsupported"], ["redx", "unsupported"]]);
  assert.deepEqual(all.map((p) => p.bookingConfigured), [false, false, false]);
  const off = await getIntelligenceProviderStatuses({ FRAUD_CHECK_ENABLED: "false", STEADFAST_ENABLED: "true", STEADFAST_API_KEY: "KEY-abcdef", STEADFAST_API_SECRET: "SEC-123456" });
  assert.equal(off[0].state, "not_configured");
  assert.match(off[0].problem ?? "", /switched off/);
  assert.equal(off[0].bookingConfigured, true); // booking credentials exist, yet the history lookup is off: different capabilities
  for (const p of all.filter((x) => x.state === "unsupported")) {
    assert.equal(p.verification.liveTested, false);
    assert.equal(p.endpoint, null);
  }
});

// ---- admin entry point ------------------------------------------------------------------------------------------------------------------------------
test("manual lookup works for ANY valid number (no customer or order needed), asks the courier fresh on demand, and is audited with the masked number only", async () => {
  const r = await adminCheckProvider({ adminId: "a1", phone: "+8801911222333", provider: "steadfast", fresh: false });
  assert.deepEqual([r.phoneValid, r.phoneMasked, r.report.status], [true, "019*****333", "ok"]);
  assert.equal(db.rows("order").length, 0);
  await adminCheckProvider({ adminId: "a1", phone: "01911222333", provider: "steadfast", fresh: false });
  assert.equal(calls.length, 1); // second plain check = cache
  const fresh = await adminCheckProvider({ adminId: "a1", phone: "01911222333", provider: "steadfast", fresh: true });
  assert.deepEqual([calls.length, fresh.report.cached], [2, false]);
  assert.equal(rows().filter((x) => x.source === "ADMIN").length, 2);
  const audits = db.rows("adminAuditEvent").filter((a) => a.action === "COURIER_INTEL_LOOKUP");
  assert.equal(audits.length, 3);
  assert.ok(audits.every((a) => a.actorId === "a1" && (a.detail as any).phoneMasked === "019*****333"));
  assert.ok(!JSON.stringify(db.rows("adminAuditEvent")).includes("01911222333"));
  assert.ok(!JSON.stringify(db.rows("adminAuditEvent")).includes("8801911222333"));
});

test("manual lookup: an invalid number is reported (no audit, no call); unsupported couriers answer 'unsupported'; unknown couriers are refused", async () => {
  const bad = await adminCheckProvider({ adminId: "a1", phone: "123", provider: "steadfast", fresh: true });
  assert.deepEqual([bad.phoneValid, bad.report.reason], [false, "invalid_phone"]);
  assert.deepEqual([calls.length, db.rows("adminAuditEvent").length], [0, 0]);
  const p = await adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "pathao", fresh: true });
  assert.equal(p.report.status, "unsupported");
  assert.equal(calls.length, 0);
  for (const unknown of ["nope", "", null, undefined, "__proto__", "constructor"]) {
    await assert.rejects(() => adminCheckProvider({ adminId: "a1", phone: PHONE, provider: unknown as any, fresh: false }), /Unknown courier/);
  }
});

test("manual lookup needs an ACTIVE admin in the database; a customer, an unknown id or nobody is refused before any call", async () => {
  db.insert("user", { id: "cust-1", role: "CUSTOMER", name: "C" } as any);
  for (const who of ["cust-1", "nobody", "", null, undefined]) {
    await assert.rejects(() => adminCheckProvider({ adminId: who as any, phone: PHONE, provider: "steadfast", fresh: false }));
  }
  assert.equal(calls.length, 0);
  assert.equal(rows().length, 0);
});

test("manual lookups are throttled per admin (and one admin's burst does not block another)", async () => {
  let refused = 0;
  for (let i = 0; i < 95; i++) {
    try { await adminCheckProvider({ adminId: "a1", phone: PHONE, provider: "steadfast", fresh: false }); } catch (e) { refused++; assert.match(String((e as Error).message), /try again|wait|too many|minute/i); }
  }
  assert.equal(refused, 5); // limit is 90 an hour
  await assert.doesNotReject(() => adminCheckProvider({ adminId: "a2", phone: PHONE, provider: "steadfast", fresh: false }));
});

test("the admin server action: admins get the normalised report only; a non-admin is refused; the browser never sees raw payloads or the full number", async () => {
  const r = await runAs("admin", () => checkCourierProviderAction({ phone: "01711000000", provider: "steadfast", fresh: true }));
  assert.ok(r.success);
  if (r.success) {
    assert.equal(r.phoneMasked, "017*****000");
    assert.deepEqual(Object.keys(r.report).sort(), ["cancelled", "cached", "checkedAt", "delivered", "failed", "fraudReports", "provider", "reason", "reportedCancellationRate", "reportedDeliveryRate", "returned", "status", "total"].sort());
    assert.ok(!JSON.stringify(r).includes(PHONE));
  }
  const bad = await runAs("admin", () => checkCourierProviderAction({ phone: "x", provider: "steadfast" }));
  assert.ok(bad.success && !bad.phoneValid);
  const unknown = await runAs("admin", () => checkCourierProviderAction({ phone: PHONE, provider: "zzz" }));
  assert.deepEqual([unknown.success, !unknown.success && /Unknown courier/.test(unknown.message)], [false, true]);
  await assert.rejects(() => runAs({ sub: "someone" }, () => checkCourierProviderAction({ phone: PHONE, provider: "steadfast" })));
});
