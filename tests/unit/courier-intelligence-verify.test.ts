/**
 * Pure rules behind multi-courier history: the verification gate, metric coverage ("unsupported is said out loud, never faked"), the
 * combination of incomplete counts, and the guard that keeps descriptors and adapters in step. No I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyHistoryMetrics } from "@/lib/courier-intelligence/verify";
import { describeMetricCoverage, unreportedMetrics, METRIC_ORDER } from "@/lib/courier-intelligence/coverage";
import { combineReports } from "@/lib/courier-intelligence/combine";
import { assessTrust, DEFAULT_EVIDENCE_POLICY } from "@/lib/courier-intelligence/trust";
import { PROVIDER_DESCRIPTORS } from "@/lib/courier-intelligence/registry";
import { EMPTY_METRICS, INTEL_PROVIDERS, type HistoryMetrics, type IntelProviderKey, type MetricName, type ProviderReport } from "@/lib/courier-intelligence/types";
import { HISTORY_ADAPTER_FACTORIES } from "@/server/services/courier-intelligence-providers";

const SF = PROVIDER_DESCRIPTORS.steadfast; // delivered, cancelled, total, fraudReports
const metrics = (o: Partial<HistoryMetrics> = {}): HistoryMetrics => ({ ...EMPTY_METRICS, empty: false, ...o });
const report = (provider: IntelProviderKey, o: Partial<ProviderReport> = {}): ProviderReport => ({
  provider, status: "ok", reason: null, checkedAt: "2026-11-23T10:00:00.000Z", cached: false, ...EMPTY_METRICS, ...o,
});
const OK = (p: IntelProviderKey, delivered: number, cancelled: number, extra: Partial<ProviderReport> = {}) => report(p, { delivered, cancelled, total: delivered + cancelled, ...extra });

// ---- the verification gate ---------------------------------------------------------------------------------------------------------------------
test("gate: a plausible answer within the documented metrics passes unchanged", () => {
  const r = verifyHistoryMetrics(SF, metrics({ delivered: 9, cancelled: 1, total: 10, fraudReports: 2 }));
  assert.ok(r.ok);
  assert.deepEqual(r.stripped, []);
  assert.deepEqual([r.metrics.delivered, r.metrics.cancelled, r.metrics.total, r.metrics.fraudReports], [9, 1, 10, 2]);
});

test("gate: a metric the courier is NOT documented to report is dropped, and named, never trusted", () => {
  const r = verifyHistoryMetrics(SF, metrics({ delivered: 9, cancelled: 1, total: 10, returned: 4, failed: 2, reportedDeliveryRate: 90, reportedCancellationRate: 10 }));
  assert.ok(r.ok);
  assert.deepEqual([r.metrics.returned, r.metrics.failed, r.metrics.reportedDeliveryRate, r.metrics.reportedCancellationRate], [null, null, null, null]);
  assert.deepEqual([...r.stripped].sort(), ["cancellationRate", "deliveryRate", "failed", "returned"]);
  assert.equal(r.metrics.delivered, 9, "supported metrics are untouched");
});

test("gate: a courier that documents NOTHING can never contribute a number (every value is dropped, so nothing remains)", () => {
  const r = verifyHistoryMetrics({ supportedMetrics: [] }, metrics({ delivered: 50, cancelled: 0, total: 50 }));
  assert.equal(r.ok, false);
});

test("gate: implausible values make the whole answer unusable (never clamped, never defaulted)", () => {
  const bad: Partial<HistoryMetrics>[] = [
    { delivered: -1, total: 5 }, { delivered: 1.5, total: 5 }, { delivered: Number.NaN, total: 5 }, { delivered: Infinity, total: Infinity },
    { delivered: 200_000_000, total: 200_000_000 }, { delivered: 1, total: 1, fraudReports: 5000 }, { delivered: 1, total: 1, fraudReports: -2 },
    { delivered: "9" as never, total: 9 },
  ];
  for (const b of bad) assert.equal(verifyHistoryMetrics(SF, metrics(b)).ok, false, JSON.stringify(b));
  const rateBad = { supportedMetrics: ["delivered", "cancelled", "total", "deliveryRate"] as MetricName[] };
  for (const v of [-1, 100.5, Number.NaN, 1000]) assert.equal(verifyHistoryMetrics(rateBad, metrics({ delivered: 1, cancelled: 0, total: 1, reportedDeliveryRate: v })).ok, false, String(v));
  assert.ok(verifyHistoryMetrics(rateBad, metrics({ delivered: 1, cancelled: 0, total: 1, reportedDeliveryRate: 100 })).ok);
});

test("gate: contradictions are unusable: total below delivered + cancelled, or 'no history' alongside parcels", () => {
  assert.equal(verifyHistoryMetrics(SF, metrics({ delivered: 5, cancelled: 5, total: 9 })).ok, false);
  assert.equal(verifyHistoryMetrics(SF, metrics({ delivered: 1, cancelled: 0, total: 1, empty: true })).ok, false);
  assert.ok(verifyHistoryMetrics(SF, metrics({ delivered: 0, cancelled: 0, total: 0, empty: true })).ok, "a genuine 'nothing on record' answer passes");
});

test("gate: an answer carrying no metric at all is not a report (it must not be mistaken for 'no history')", () => {
  assert.equal(verifyHistoryMetrics(SF, metrics()).ok, false);
  assert.equal(verifyHistoryMetrics(SF, metrics({ returned: 3 })).ok, false, "only an unsupported metric -> nothing left after the gate");
});

test("gate: undefined fields are normalised to null (a missing field is never zero)", () => {
  const partial = { delivered: 2, cancelled: 0, total: 2, empty: false } as unknown as HistoryMetrics;
  const r = verifyHistoryMetrics(SF, partial);
  assert.ok(r.ok);
  assert.equal(r.metrics.fraudReports, null);
  assert.equal(r.metrics.returned, null);
});

test("gate: it never mutates the adapter's object", () => {
  const input = metrics({ delivered: 1, cancelled: 0, total: 1, returned: 9 });
  verifyHistoryMetrics(SF, input);
  assert.equal(input.returned, 9);
});

// ---- metric coverage ---------------------------------------------------------------------------------------------------------------------------
test("coverage with the real descriptors: Steadfast reports four metrics; every other metric is 'unsupported by courier' for all three, never zero", () => {
  const cov = describeMetricCoverage([OK("steadfast", 9, 1, { fraudReports: 0 })]);
  assert.deepEqual(cov.map((c) => c.metric), [...METRIC_ORDER]);
  const by = Object.fromEntries(cov.map((c) => [c.metric, c]));
  for (const m of ["delivered", "cancelled", "total", "fraudReports"]) assert.deepEqual(by[m].reportedBy, ["steadfast"], m);
  for (const m of ["returned", "failed", "deliveryRate", "cancellationRate"]) {
    assert.deepEqual(by[m].reportedBy, [], m);
    assert.deepEqual(by[m].missing.map((x) => [x.provider, x.why]), [["steadfast", "unsupported_by_courier"], ["pathao", "unsupported_by_courier"], ["redx", "unsupported_by_courier"]], m);
  }
  assert.deepEqual(by.delivered.missing.map((x) => [x.provider, x.why]), [["pathao", "unsupported_by_courier"], ["redx", "unsupported_by_courier"]]);
  assert.deepEqual(unreportedMetrics(cov).map((c) => c.metric), ["returned", "failed", "deliveryRate", "cancellationRate"]);
});

test("coverage separates 'cannot ever report it' from 'did not answer this time' (the latter is UNKNOWN, not zero)", () => {
  const supportsAll = (k: IntelProviderKey) => ({ capability: "supported" as const, supportedMetrics: PROVIDER_DESCRIPTORS[k].supportedMetrics.length ? PROVIDER_DESCRIPTORS[k].supportedMetrics : (["delivered", "cancelled", "total"] as MetricName[]) });
  const reports = [
    OK("steadfast", 9, 1, { fraudReports: 0 }),
    report("pathao", { status: "unavailable", reason: "timeout" }),
    report("redx", { status: "ok", delivered: 4, cancelled: 1 }), // answered without a total
  ];
  const cov = describeMetricCoverage(reports, supportsAll);
  const total = cov.find((c) => c.metric === "total")!;
  assert.deepEqual(total.reportedBy, ["steadfast"]);
  assert.deepEqual(total.missing.map((x) => [x.provider, x.why]), [["pathao", "no_answer"], ["redx", "not_in_answer"]]);
  assert.deepEqual(cov.find((c) => c.metric === "delivered")!.reportedBy, ["steadfast", "redx"]);
});

test("coverage: a rate counts as reported only when the courier gave it", () => {
  const d = () => ({ capability: "supported" as const, supportedMetrics: ["delivered", "cancelled", "deliveryRate"] as MetricName[] });
  const cov = describeMetricCoverage([report("steadfast", { delivered: 1, cancelled: 0, reportedDeliveryRate: 100 })], d);
  assert.deepEqual(cov.find((c) => c.metric === "deliveryRate")!.reportedBy, ["steadfast"]);
  assert.deepEqual(cov.find((c) => c.metric === "cancellationRate")!.missing.find((x) => x.provider === "steadfast")!.why, "unsupported_by_courier");
});

// ---- combination: incomplete counts -------------------------------------------------------------------------------------------------------------
test("combine: a courier giving only one of delivered / cancelled is excluded as 'incomplete counts' (the other is never invented) and the others still count", () => {
  const c = combineReports([OK("steadfast", 8, 2), report("pathao", { delivered: 7 })]);
  assert.deepEqual(c.contributing, ["steadfast"]);
  assert.deepEqual(c.excluded.map((e) => [e.provider, e.why]), [["pathao", "incomplete_counts"]]);
  assert.deepEqual([c.delivered, c.cancelled, c.deliverySuccessRate], [8, 2, 80]);
});

test("combine: with ONLY incomplete counts the state is 'insufficient' (data exists but cannot be relied on), and trust treats it as unrated", () => {
  const c = combineReports([report("pathao", { delivered: 7 })]);
  assert.equal(c.state, "insufficient");
  assert.equal(c.deliverySuccessRate, null);
  const t = assessTrust({ combined: c, phoneVerified: true, policy: { ...DEFAULT_EVIDENCE_POLICY, rewardEnabled: true } });
  assert.deepEqual([t.state, t.rate, t.rewardAllowed], ["insufficient", null, false]);
});

test("combine: a rate-only answer is still 'percentage_only' (unchanged)", () => {
  const c = combineReports([report("redx", { reportedDeliveryRate: 90 })]);
  assert.deepEqual(c.excluded.map((e) => e.why), ["percentage_only"]);
  assert.equal(c.state, "insufficient");
});

// ---- registry / adapter drift guard ------------------------------------------------------------------------------------------------------------
test("registry: the couriers with an adapter are exactly the couriers documented as supported (no capability without code, no code without capability)", () => {
  const supported = INTEL_PROVIDERS.filter((k) => PROVIDER_DESCRIPTORS[k].capability === "supported").sort();
  assert.deepEqual(Object.keys(HISTORY_ADAPTER_FACTORIES).sort(), supported);
  assert.deepEqual(supported, ["steadfast"]);
});

test("registry: Pathao and REDX stay unsupported on the 2026-11-23 re-check, with the evidence recorded and no endpoint to call", () => {
  for (const k of ["pathao", "redx"] as const) {
    const d = PROVIDER_DESCRIPTORS[k];
    assert.deepEqual([d.capability, d.verification.state, d.verification.verifiedOn, d.verification.liveTested, d.endpoint], ["unsupported", "not_documented", "2026-11-23", false, null], k);
    assert.deepEqual([...d.supportedMetrics], []);
    assert.equal(d.unsupportedMetrics.length, 8, "every metric is listed as unsupported");
    assert.ok(!(k in HISTORY_ADAPTER_FACTORIES));
  }
  assert.match(PROVIDER_DESCRIPTORS.pathao.verification.source, /None of these is published by Pathao/);
  assert.match(PROVIDER_DESCRIPTORS.pathao.verification.source, /PANEL/);
  assert.match(PROVIDER_DESCRIPTORS.redx.verification.source, /OTP/);
  assert.match(PROVIDER_DESCRIPTORS.redx.verification.source, /no customer history lookup/);
});

test("registry: Steadfast's supported and unsupported metrics partition all eight metrics (nothing is both, nothing is forgotten)", () => {
  for (const k of INTEL_PROVIDERS) {
    const d = PROVIDER_DESCRIPTORS[k];
    const all = [...d.supportedMetrics, ...d.unsupportedMetrics].sort();
    assert.deepEqual(all, [...METRIC_ORDER].sort(), k);
  }
});
