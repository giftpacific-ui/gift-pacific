/** P6 pure rules: the Steadfast response mapper, the combined report, the provider registry and the adapter transport. No database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSteadfastHistoryBody } from "@/lib/courier-intelligence/steadfast-map";
import { combineReports, orderReports } from "@/lib/courier-intelligence/combine";
import { KNOWN_FRAUD_PROVIDERS, PROVIDER_DESCRIPTORS } from "@/lib/courier-intelligence/registry";
import { EMPTY_METRICS, FAILURE_TEXT, INTEL_PROVIDERS, type IntelProviderKey, type ProviderReport } from "@/lib/courier-intelligence/types";
import { createSteadfastHistoryAdapter, mapSteadfastHistoryResult } from "@/server/services/courier-intelligence-providers/steadfast";
import type { HttpResult } from "@/lib/courier/http";
import { normalizeBdPhone } from "@/lib/advance-policy";

const ok = (over: Record<string, unknown> = {}) => ({ total_parcels: 24, total_delivered: 9, total_cancelled: 15, total_fraud_reports: [] as unknown[], ...over });

// ---- phone normalisation -----------------------------------------------------------------------------------------------------------------------
test("phone normalisation: every accepted Bangladesh format becomes 01XXXXXXXXX; everything else is rejected", () => {
  for (const p of ["01711000000", "+8801711000000", "8801711000000", "008801711000000", " 01711-000 000 ", "০১৭১১০০০০০০"]) {
    const n = normalizeBdPhone(p);
    assert.ok(n === null || /^01[3-9]\d{8}$/.test(n), p);
  }
  assert.equal(normalizeBdPhone("+8801711000000"), "01711000000");
  assert.equal(normalizeBdPhone("8801711000000"), "01711000000");
  for (const bad of [null, undefined, "", "abc", "12345", "01211000000", "0171100000", "017110000000", "+9111000000000", "01711000000'; DROP", "../01711000000"]) {
    assert.equal(normalizeBdPhone(bad as string), null, String(bad));
  }
});

// ---- Steadfast response mapper -------------------------------------------------------------------------------------------------------------------
test("Steadfast mapper: documented counts map to delivered / cancelled / total, and nothing is derived from them", () => {
  const r = mapSteadfastHistoryBody(ok());
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual([r.metrics.delivered, r.metrics.cancelled, r.metrics.total, r.metrics.fraudReports, r.metrics.empty], [9, 15, 24, 0, false]);
    // not reported by Steadfast: stays null, never zero, never derived
    assert.deepEqual([r.metrics.returned, r.metrics.failed, r.metrics.reportedDeliveryRate, r.metrics.reportedCancellationRate], [null, null, null, null]);
  }
});

test("Steadfast mapper: only the COUNT of fraud reports is kept; their contents are never read", () => {
  const items = [{ name: "Other Merchant Ltd", phone: "01999999999", details: "private" }, { x: 1 }];
  const r = mapSteadfastHistoryBody(ok({ total_fraud_reports: items }));
  assert.ok(r.ok && r.metrics.fraudReports === 2);
  assert.ok(!JSON.stringify(r).includes("Other Merchant"));
  const none = mapSteadfastHistoryBody({ total_parcels: 1, total_delivered: 1, total_cancelled: 0 });
  assert.ok(none.ok && none.metrics.fraudReports === null); // absent -> null, not 0
  const weird = mapSteadfastHistoryBody(ok({ total_fraud_reports: "none" }));
  assert.ok(weird.ok && weird.metrics.fraudReports === null);
  assert.ok(mapSteadfastHistoryBody(ok({ total_fraud_reports: new Array(5000).fill(0) })).ok);
  const capped = mapSteadfastHistoryBody(ok({ total_fraud_reports: new Array(5000).fill(0) }));
  assert.ok(capped.ok && capped.metrics.fraudReports === 1000);
});

test("Steadfast mapper: zero everywhere is 'no history' (a real answer)", () => {
  const r = mapSteadfastHistoryBody({ total_parcels: 0, total_delivered: 0, total_cancelled: 0, total_fraud_reports: [] });
  assert.ok(r.ok && r.metrics.empty === true);
  assert.ok(mapSteadfastHistoryBody(ok({ total_parcels: 3, total_delivered: 0, total_cancelled: 0 })).ok); // parcels in progress only: has history, no outcomes yet
  const prog = mapSteadfastHistoryBody(ok({ total_parcels: 3, total_delivered: 0, total_cancelled: 0 }));
  assert.ok(prog.ok && prog.metrics.empty === false);
});

test("Steadfast mapper: malformed or contradictory answers are unusable (invalid_response), never positive trust", () => {
  const bad: unknown[] = [
    null, undefined, "x", 5, [], {}, { status: 200 },
    ok({ total_parcels: "24" }), ok({ total_delivered: 9.5 }), ok({ total_cancelled: -1 }), ok({ total_parcels: null }),
    ok({ total_parcels: Number.NaN }), ok({ total_delivered: Infinity }), ok({ total_parcels: 1e12 }),
    ok({ total_parcels: 10, total_delivered: 9, total_cancelled: 15 }), // total smaller than its parts
    { delivered_count: 9, cancelled_count: 1 },                          // the field names the OLD adapter assumed are not the documented ones
    { total_delivered: 9, total_cancelled: 1 },                          // missing total
  ];
  for (const b of bad) assert.deepEqual(mapSteadfastHistoryBody(b), { ok: false, reason: "invalid_response" }, JSON.stringify(b));
});

test("Steadfast mapper: a body carrying a non-200 status is a typed failure, not a result", () => {
  assert.deepEqual(mapSteadfastHistoryBody({ status: 401, message: "bad key" }), { ok: false, reason: "auth_failed" });
  assert.deepEqual(mapSteadfastHistoryBody({ status: 403 }), { ok: false, reason: "auth_failed" });
  assert.deepEqual(mapSteadfastHistoryBody({ status: 429 }), { ok: false, reason: "rate_limited" });
  assert.deepEqual(mapSteadfastHistoryBody(ok({ status: 500 })), { ok: false, reason: "error" });
  assert.ok(mapSteadfastHistoryBody(ok({ status: 200 })).ok);
});

test("a percentage-only provider answer is never turned into counts (no verified denominator)", () => {
  assert.equal(mapSteadfastHistoryBody({ delivery_rate: 92, cancellation_rate: 8 }).ok, false);
  assert.equal(mapSteadfastHistoryBody({ success_ratio: 0.9, volume: "10-50" }).ok, false);
});

test("transport results map to typed failures that carry only a reason code", () => {
  const cases: [HttpResult, string][] = [
    [{ kind: "http_error", status: 401, json: null }, "auth_failed"],
    [{ kind: "http_error", status: 403, json: null }, "auth_failed"],
    [{ kind: "http_error", status: 429, json: null }, "rate_limited"],
    [{ kind: "http_error", status: 500, json: { message: "boom at https://secret.example/01711000000" } }, "error"],
    [{ kind: "invalid_response", status: 200 }, "invalid_response"],
    [{ kind: "network", message: "The courier did not answer in time." }, "timeout"],
    [{ kind: "network", message: "Could not reach the courier." }, "error"],
  ];
  for (const [r, reason] of cases) {
    const m = mapSteadfastHistoryResult(r);
    assert.deepEqual(m, { ok: false, reason });
    assert.ok(Object.keys(FAILURE_TEXT).includes(reason));
    assert.doesNotMatch(JSON.stringify(m), /secret|01711|https?:/);
  }
  assert.ok(mapSteadfastHistoryResult({ kind: "ok", status: 200, json: ok() }).ok);
});

// ---- adapter -------------------------------------------------------------------------------------------------------------------------------------
const env = { STEADFAST_ENABLED: "true", STEADFAST_API_KEY: "KEY-abcdef", STEADFAST_API_SECRET: "SEC-123456" };

test("the adapter exists only when the Steadfast courier credentials are complete, enabled and valid", () => {
  assert.equal(createSteadfastHistoryAdapter({ env: {} }), null);
  assert.equal(createSteadfastHistoryAdapter({ env: { STEADFAST_API_KEY: "KEY-abcdef" } }), null);
  assert.equal(createSteadfastHistoryAdapter({ env: { ...env, STEADFAST_ENABLED: "false" } }), null);
  assert.equal(createSteadfastHistoryAdapter({ env: { ...env, STEADFAST_API_BASE_URL: "http://evil.example" } }), null); // plain http only for localhost
  assert.ok(createSteadfastHistoryAdapter({ env }));
});

test("the request is GET {base}/fraud_check/{phone} (the documented path) with the courier's Api-Key / Secret-Key headers and the given timeout", async () => {
  const seen: { url: string; init: { method: string; headers: Record<string, string>; body?: unknown }; timeout: number }[] = [];
  const request = (async (url: string, init: never, timeout: number) => { seen.push({ url, init, timeout }); return { kind: "ok", status: 200, json: ok() }; }) as never;
  const a = createSteadfastHistoryAdapter({ env: { ...env, STEADFAST_API_BASE_URL: "https://portal.example.test/api/v1/" }, request })!;
  const r = await a.lookup("01711000000", 2500);
  assert.ok(r.ok);
  assert.equal(seen[0].url, "https://portal.example.test/api/v1/fraud_check/01711000000"); // trailing slash trimmed; NOT /fraud_check/score/
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.body, undefined);
  assert.deepEqual([seen[0].init.headers["Api-Key"], seen[0].init.headers["Secret-Key"], seen[0].timeout], ["KEY-abcdef", "SEC-123456", 2500]);
  // default base URL
  const d = createSteadfastHistoryAdapter({ env, request })!;
  await d.lookup("01711000000", 1000);
  assert.equal(seen[1].url, "https://portal.packzy.com/api/v1/fraud_check/01711000000");
  // read-only and NOT retried
  const flaky = (async () => { seen.push({ url: "x", init: { method: "GET", headers: {} }, timeout: 0 }); return { kind: "network", message: "Could not reach the courier." }; }) as never;
  const before = seen.length;
  const f = createSteadfastHistoryAdapter({ env, request: flaky })!;
  assert.deepEqual(await f.lookup("01711000000", 1000), { ok: false, reason: "error" });
  assert.equal(seen.length - before, 1);
});

test("anything that is not a normalised Bangladesh mobile number never reaches the URL", async () => {
  let called = 0;
  const a = createSteadfastHistoryAdapter({ env, request: (async () => { called++; return { kind: "ok", status: 200, json: ok() }; }) as never })!;
  for (const bad of ["", "abc", "1711000000", "+8801711000000", "01711000000/../x", "01711000000?x=1", "0171100000", "01211000000"]) {
    assert.deepEqual(await a.lookup(bad, 1000), { ok: false, reason: "invalid_phone" }, bad);
  }
  assert.equal(called, 0);
});

// ---- registry ------------------------------------------------------------------------------------------------------------------------------------
test("registry: only Steadfast has a lookup; Pathao and REDX are explicitly unsupported with the evidence recorded and no live test claimed", () => {
  assert.deepEqual(INTEL_PROVIDERS, ["steadfast", "pathao", "redx"]);
  const supported = INTEL_PROVIDERS.filter((k) => PROVIDER_DESCRIPTORS[k].capability === "supported");
  assert.deepEqual(supported, ["steadfast"]);
  assert.deepEqual([...KNOWN_FRAUD_PROVIDERS], supported); // the constant can never drift from the descriptors
  for (const k of INTEL_PROVIDERS) {
    const d = PROVIDER_DESCRIPTORS[k];
    assert.equal(d.key, k);
    assert.equal(d.verification.liveTested, false);                    // nothing here was ever run against a live API
    assert.match(d.verification.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(d.verification.source.length > 40);
    if (d.capability === "unsupported") {
      assert.equal(d.endpoint, null);                                  // no endpoint is claimed for an undocumented lookup
      assert.deepEqual(d.supportedMetrics, []);
      assert.equal(d.verification.state, "not_documented");
    } else {
      assert.match(d.endpoint ?? "", /fraud_check\/\{phone\}$/);
      assert.ok(!(d.endpoint ?? "").includes("/score/"));
      assert.ok(d.supportedMetrics.includes("delivered") && d.supportedMetrics.includes("cancelled"));
      assert.ok(d.unsupportedMetrics.includes("returned") && d.unsupportedMetrics.includes("failed"));
    }
  }
});

// ---- combined report ------------------------------------------------------------------------------------------------------------------------------
const rep = (provider: IntelProviderKey, over: Partial<ProviderReport> = {}): ProviderReport => ({
  provider, status: "ok", reason: null, checkedAt: "2026-11-21T10:00:00.000Z", cached: false, ...EMPTY_METRICS, delivered: 0, cancelled: 0, total: 0, ...over,
});
const down = (provider: IntelProviderKey, status: ProviderReport["status"] = "unavailable", reason: ProviderReport["reason"] = "timeout"): ProviderReport => rep(provider, { status, reason, delivered: null, cancelled: null, total: null });

test("combined: the rate is delivered / (delivered + cancelled); not-classified parcels and returned/failed are shown but excluded, with an explanation", () => {
  const c = combineReports([rep("steadfast", { delivered: 9, cancelled: 3, total: 20 })]);
  assert.deepEqual([c.state, c.deliverySuccessRate, c.finalOutcomes, c.delivered, c.cancelled, c.notClassified, c.totalReported], ["valid", 75, 12, 9, 3, 8, 20]);
  const ret = combineReports([rep("steadfast", { delivered: 6, cancelled: 2, returned: 4, failed: 1, total: 13 })]);
  assert.equal(ret.deliverySuccessRate, 75);                                  // returned (4) and failed (1) are NOT in the denominator
  assert.deepEqual([ret.returned, ret.failed, ret.notClassified], [4, 1, 0]);
  assert.match(ret.notes.join(" "), /not part of the rate/);
});

test("combined: two couriers' counts are summed; the figures say they are NOT deduplicated, and the oldest check is reported", () => {
  const c = combineReports([
    rep("steadfast", { delivered: 8, cancelled: 2, total: 10, checkedAt: "2026-11-21T10:00:00.000Z" }),
    rep("pathao", { delivered: 2, cancelled: 3, total: 5, checkedAt: "2026-11-21T09:00:00.000Z" }),
  ]);
  assert.deepEqual([c.state, c.delivered, c.cancelled, c.deliverySuccessRate, c.contributing], ["valid", 10, 5, 66.7, ["steadfast", "pathao"]]);
  assert.equal(c.crossProviderDeduplicated, false);
  assert.match(c.notes.join(" "), /not globally deduplicated/);
  assert.equal(c.oldestCheckedAt, "2026-11-21T09:00:00.000Z");
});

test("combined: a provider's missing data is NEVER treated as zero (an unavailable courier changes nothing)", () => {
  const withBad = combineReports([rep("steadfast", { delivered: 8, cancelled: 2, total: 10 }), down("pathao"), down("redx", "not_configured", null)]);
  const alone = combineReports([rep("steadfast", { delivered: 8, cancelled: 2, total: 10 })]);
  assert.equal(withBad.deliverySuccessRate, alone.deliverySuccessRate);
  assert.deepEqual(withBad.contributing, ["steadfast"]);
  assert.deepEqual(withBad.excluded.map((e) => [e.provider, e.why]), [["pathao", "unavailable"], ["redx", "not_configured"]]);
  assert.match(withBad.notes.join(" "), /Steadfast only/);
});

test("combined: only 'unavailable' / 'unsupported' / 'not configured' is not a rate; no courier data never becomes a fabricated number", () => {
  const none = combineReports([down("steadfast"), down("pathao", "unsupported", null), down("redx", "not_configured", null)]);
  assert.deepEqual([none.state, none.deliverySuccessRate, none.finalOutcomes, none.contributing], ["unavailable", null, 0, []]);
  assert.match(none.notes.join(" "), /no delivery rate can be shown/);
  assert.equal(combineReports([]).deliverySuccessRate, null);
  assert.equal(combineReports([]).state, "unavailable");
  assert.deepEqual(none.excluded.map((e) => e.why), ["unavailable", "unsupported", "not_configured"]);
});

test("combined: 'no history' is a real answer (zero), not a failure and not a rate", () => {
  const c = combineReports([rep("steadfast", { status: "no_history" })]);
  assert.deepEqual([c.state, c.deliverySuccessRate, c.contributing, c.finalOutcomes], ["no_history", null, ["steadfast"], 0]);
  // ...and it still contributes zero next to a courier with history
  const mixed = combineReports([rep("steadfast", { status: "no_history" }), rep("pathao", { delivered: 3, cancelled: 1, total: 4 })]);
  assert.deepEqual([mixed.deliverySuccessRate, mixed.contributing], [75, ["steadfast", "pathao"]]);
});

test("combined: a percentage-only answer is displayed on its own but never enters the combined counts or rate", () => {
  const pct = rep("pathao", { delivered: null, cancelled: null, total: null, reportedDeliveryRate: 93.5, reportedCancellationRate: 6.5 });
  const alone = combineReports([pct]);
  assert.deepEqual([alone.state, alone.deliverySuccessRate, alone.contributing], ["insufficient", null, []]);
  assert.deepEqual(alone.providerRates, [{ provider: "pathao", deliveryRate: 93.5, cancellationRate: 6.5 }]);
  assert.deepEqual(alone.excluded.map((e) => e.why), ["percentage_only"]);
  assert.match(alone.notes.join(" "), /cannot be calculated/);
  const next = combineReports([pct, rep("steadfast", { delivered: 9, cancelled: 1, total: 10 })]);
  assert.deepEqual([next.deliverySuccessRate, next.delivered, next.cancelled, next.contributing], [90, 9, 1, ["steadfast"]]);
  assert.equal(next.providerRates.length, 1); // still shown, separately
});

test("combined: all-zero outcomes with parcels still in progress is not a rate; a lone delivered parcel is 100% (judging reliability is the policy's job, not the combiner's)", () => {
  const progress = combineReports([rep("steadfast", { delivered: 0, cancelled: 0, total: 3 })]);
  assert.deepEqual([progress.state, progress.deliverySuccessRate, progress.notClassified], ["no_history", null, 3]);
  const one = combineReports([rep("steadfast", { delivered: 1, cancelled: 0, total: 1 })]);
  assert.deepEqual([one.state, one.deliverySuccessRate, one.finalOutcomes], ["valid", 100, 1]);
});

test("combined: fraud-report counts are summed and displayed only (never in the rate)", () => {
  const c = combineReports([rep("steadfast", { delivered: 5, cancelled: 5, total: 10, fraudReports: 3 })]);
  assert.deepEqual([c.fraudReports, c.deliverySuccessRate], [3, 50]);
  assert.equal(combineReports([rep("steadfast", { delivered: 5, cancelled: 5, total: 10 })]).fraudReports, null);
});

test("combined: reports are ordered steadfast, pathao, redx and none is dropped silently", () => {
  const o = orderReports([down("redx"), rep("steadfast"), down("pathao")]);
  assert.deepEqual(o.map((r) => r.provider), ["steadfast", "pathao", "redx"]);
});
