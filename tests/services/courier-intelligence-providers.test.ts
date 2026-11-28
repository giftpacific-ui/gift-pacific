/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Multi-courier customer-history lookups against the real intelligence service (in-memory database).
 *
 * WHAT THESE TESTS ARE: Pathao and REDX publish NO customer-history contract (registry, re-checked 2026-11-23), so in production they are
 * `unsupported` and never called. To prove that the pipeline would handle them correctly if one ever gets a verified contract, the tests below
 * model them with MOCK adapters and MOCK descriptors through test-only seams, and run every combination of the three couriers. Nothing here says
 * anything about what the real Pathao or REDX APIs return, and nothing here ever reaches a network.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import {
  descriptorFor, getCourierIntelligence, getProviderReport, getStoredIntelligence, hashPhone, resetIntelligenceStateForTests,
  setIntelligenceAdaptersForTests, setIntelligenceClockForTests, setIntelligenceDescriptorsForTests,
} from "@/server/services/courier-intelligence.service";
import { PROVIDER_DESCRIPTORS } from "@/lib/courier-intelligence/registry";
import { assessTrust, DEFAULT_EVIDENCE_POLICY } from "@/lib/courier-intelligence/trust";
import { describeMetricCoverage } from "@/lib/courier-intelligence/coverage";
import { EMPTY_METRICS, INTEL_PROVIDERS, type HistoryAdapter, type HistoryAnswer, type IntelProviderKey, type MetricName, type ProviderDescriptor } from "@/lib/courier-intelligence/types";

let db: FakeDb;
let clock = 1_800_000_000_000;
const PHONE = "01711000000";
const PHONE2 = "01811000000";
const SECRET = "SEC-live-123456";
const KEYS = ["FRAUD_CHECK_ENABLED", "FRAUD_CHECK_PROVIDER", "FRAUD_CHECK_TIMEOUT_MS", "FRAUD_CHECK_CACHE_SECONDS", "FRAUD_CHECK_MAX_CALLS_PER_MINUTE", "COURIER_INTEL_RETENTION_DAYS", "RATE_LIMIT_ENABLED", "AUTH_SECRET"];
const saved: Record<string, string | undefined> = {};
const rows = () => db.rows("courierIntelligenceSnapshot");

// ---- MOCK couriers: distinct figures per courier, so a mixed-up sum or a mis-filed row is visible ---------------------------------------------------
type Figures = { delivered: number; cancelled: number; total: number; returned?: number; fraudReports?: number };
const FIG: Record<IntelProviderKey, Figures> = {
  steadfast: { delivered: 9, cancelled: 1, total: 10, fraudReports: 0 },
  pathao: { delivered: 6, cancelled: 4, total: 10 },
  redx: { delivered: 20, cancelled: 5, total: 28, returned: 3 },
};
/** What each MOCK courier is documented (here: pretended) to report. Steadfast uses its REAL descriptor. */
const SUPPORTED: Record<IntelProviderKey, MetricName[]> = {
  steadfast: [...PROVIDER_DESCRIPTORS.steadfast.supportedMetrics],
  pathao: ["delivered", "cancelled", "total"],
  redx: ["delivered", "cancelled", "returned", "total"],
};
const ALL_METRICS: MetricName[] = ["delivered", "cancelled", "returned", "failed", "total", "deliveryRate", "cancellationRate", "fraudReports"];
const mockDescriptor = (k: IntelProviderKey): ProviderDescriptor => ({
  ...PROVIDER_DESCRIPTORS[k], capability: "supported", supportedMetrics: SUPPORTED[k], unsupportedMetrics: ALL_METRICS.filter((m) => !SUPPORTED[k].includes(m)),
});
const figuresAnswer = (k: IntelProviderKey): HistoryAnswer => {
  const f = FIG[k];
  return { ok: true, metrics: { ...EMPTY_METRICS, delivered: f.delivered, cancelled: f.cancelled, total: f.total, returned: f.returned ?? null, fraudReports: f.fraudReports ?? null, empty: false } };
};

type Spy = HistoryAdapter & { calls: string[] };
function adapter(k: IntelProviderKey, script: (phone: string) => Promise<HistoryAnswer> = async () => figuresAnswer(k)): Spy {
  const a: Spy = { key: k, calls: [], async lookup(phone) { a.calls.push(phone); return script(phone); } };
  return a;
}
/** Installs the mock world: pathao and redx are modelled as supported; each courier gets the given adapter (null = not configured). */
function world(adapters: Partial<Record<IntelProviderKey, Spy | null>>) {
  setIntelligenceDescriptorsForTests({ pathao: mockDescriptor("pathao"), redx: mockDescriptor("redx") });
  setIntelligenceAdaptersForTests({ steadfast: null, pathao: null, redx: null, ...adapters } as any);
}
const ask = (phone: string | null = PHONE, o: { fresh?: boolean; maxAgeSeconds?: number } = {}) => getCourierIntelligence(phone, { source: "CHECKOUT", ...o });
const ORDER = (set: readonly IntelProviderKey[]) => INTEL_PROVIDERS.filter((k) => set.includes(k));
const round1 = (n: number) => Math.round(n * 10) / 10;

beforeEach(() => {
  db = freshDb();
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.AUTH_SECRET = "test-secret-for-hashing-0123456789";
  clock = 1_800_000_000_000;
  setIntelligenceClockForTests(() => clock);
  resetIntelligenceStateForTests();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setIntelligenceClockForTests(undefined);
  setIntelligenceAdaptersForTests(undefined);
  setIntelligenceDescriptorsForTests(undefined);
  resetIntelligenceStateForTests();
});

// =====================================================================================================================================================
// 1. REAL world: only Steadfast is supported. Pathao and REDX are reported honestly and never called.
// =====================================================================================================================================================
test("REAL descriptors, Steadfast only: Pathao and REDX read 'unsupported', are never called, and every metric they cannot give is named, not zero", async () => {
  const sf = adapter("steadfast");
  const trapP = adapter("pathao", async () => figuresAnswer("pathao"));
  const trapR = adapter("redx", async () => figuresAnswer("redx"));
  setIntelligenceAdaptersForTests({ steadfast: sf, pathao: trapP, redx: trapR } as any);
  const r = await ask();
  assert.deepEqual(r.reports.map((x) => [x.provider, x.status]), [["steadfast", "ok"], ["pathao", "unsupported"], ["redx", "unsupported"]]);
  assert.deepEqual([sf.calls.length, trapP.calls.length, trapR.calls.length], [1, 0, 0]);
  assert.deepEqual([r.combined.contributing, r.combined.delivered, r.combined.cancelled, r.combined.deliverySuccessRate], [["steadfast"], 9, 1, 90]);
  assert.deepEqual(r.combined.excluded.map((e) => [e.provider, e.why]), [["pathao", "unsupported"], ["redx", "unsupported"]]);
  assert.equal(r.combined.returned, null, "Steadfast reports no returned count: it stays null, not 0");
  assert.equal(r.combined.failed, null);
  for (const u of r.reports.filter((x) => x.provider !== "steadfast")) {
    assert.deepEqual([u.delivered, u.cancelled, u.returned, u.failed, u.total, u.fraudReports], [null, null, null, null, null, null]);
  }
  const unreported = describeMetricCoverage(r.reports, descriptorFor).filter((c) => c.reportedBy.length === 0).map((c) => c.metric);
  assert.deepEqual(unreported, ["returned", "failed", "deliveryRate", "cancellationRate"]);
  assert.deepEqual([...new Set(rows().map((x) => x.provider))], ["steadfast"], "an unsupported courier writes nothing");
});

test("REAL descriptors: the test seam really is inert for capability (an injected adapter cannot make Pathao supported)", () => {
  assert.equal(descriptorFor("pathao").capability, "unsupported");
  assert.equal(descriptorFor("redx").capability, "unsupported");
  assert.equal(descriptorFor("steadfast").capability, "supported");
});

// =====================================================================================================================================================
// 2. Every combination of the three couriers (MOCK Pathao / REDX): 8 subsets of "configured and answering"
// =====================================================================================================================================================
const SUBSETS: IntelProviderKey[][] = [[], ["steadfast"], ["pathao"], ["redx"], ["steadfast", "pathao"], ["steadfast", "redx"], ["pathao", "redx"], ["steadfast", "pathao", "redx"]];
for (const subset of SUBSETS) {
  test(`combination [${subset.join(" + ") || "none"}]: only the couriers that answered are combined; the rest are 'not configured', never called, never zero`, async () => {
    const spies = Object.fromEntries(INTEL_PROVIDERS.map((k) => [k, subset.includes(k) ? adapter(k) : null])) as Record<IntelProviderKey, Spy | null>;
    world(spies);
    const r = await ask();
    const want = ORDER(subset);

    // per-courier reports
    assert.deepEqual(r.reports.map((x) => [x.provider, x.status]), INTEL_PROVIDERS.map((k) => [k, subset.includes(k) ? "ok" : "not_configured"]));
    for (const k of INTEL_PROVIDERS) assert.equal(spies[k]?.calls.length ?? 0, subset.includes(k) ? 1 : 0, `${k} calls`);
    for (const k of want) {
      const rep = r.reports.find((x) => x.provider === k)!;
      assert.deepEqual([rep.delivered, rep.cancelled, rep.total, rep.returned], [FIG[k].delivered, FIG[k].cancelled, FIG[k].total, FIG[k].returned ?? null], `${k} figures`);
    }

    // combined figures = independent arithmetic over exactly the answering couriers
    const delivered = want.reduce((a, k) => a + FIG[k].delivered, 0);
    const cancelled = want.reduce((a, k) => a + FIG[k].cancelled, 0);
    assert.deepEqual(r.combined.contributing, want);
    assert.deepEqual([r.combined.delivered, r.combined.cancelled, r.combined.finalOutcomes], [delivered, cancelled, delivered + cancelled]);
    assert.equal(r.combined.deliverySuccessRate, want.length ? round1((delivered / (delivered + cancelled)) * 100) : null);
    assert.equal(r.combined.state, want.length ? "valid" : "unavailable");
    assert.equal(r.combined.returned, subset.includes("redx") ? 3 : null, "returned comes from REDX alone and is never invented for the others");
    assert.equal(r.combined.fraudReports, subset.includes("steadfast") ? 0 : null);
    assert.equal(r.combined.totalReported, want.length ? want.reduce((a, k) => a + FIG[k].total, 0) : null);
    assert.deepEqual(r.combined.excluded.map((e) => [e.provider, e.why]), INTEL_PROVIDERS.filter((k) => !subset.includes(k)).map((k) => [k, "not_configured"]));
    assert.equal(r.combined.crossProviderDeduplicated, false);

    // evidence: one snapshot per answering courier, filed under its own provider, holding only that courier's figures
    assert.deepEqual(rows().map((x) => x.provider).sort(), [...want].sort());
    for (const row of rows()) {
      const k = row.provider as IntelProviderKey;
      assert.deepEqual([row.status, row.delivered, row.cancelled, row.total, row.returned ?? null, row.source], ["ok", FIG[k].delivered, FIG[k].cancelled, FIG[k].total, FIG[k].returned ?? null, "CHECKOUT"], k);
      assert.equal(row.phoneHash, hashPhone(PHONE));
      assert.equal(row.phoneMasked, "017*****000");
    }
  });
}

test("all three couriers: figures from different couriers are summed per metric, and each courier's own meaning of 'returned' stays separate from the rate", async () => {
  world({ steadfast: adapter("steadfast"), pathao: adapter("pathao"), redx: adapter("redx") });
  const r = await ask();
  assert.deepEqual([r.combined.delivered, r.combined.cancelled, r.combined.finalOutcomes, r.combined.deliverySuccessRate], [35, 10, 45, 77.8]);
  assert.equal(r.combined.returned, 3);
  assert.equal(r.combined.notClassified, 0);
  assert.match(r.combined.notes.join(" "), /not globally deduplicated/);
  assert.match(r.combined.notes.join(" "), /Returned and failed parcels are shown separately/);
  const cov = describeMetricCoverage(r.reports, descriptorFor);
  assert.deepEqual(cov.find((c) => c.metric === "returned")!.reportedBy, ["redx"]);
  assert.deepEqual(cov.find((c) => c.metric === "returned")!.missing.map((m) => [m.provider, m.why]), [["steadfast", "unsupported_by_courier"], ["pathao", "unsupported_by_courier"]]);
  assert.deepEqual(cov.find((c) => c.metric === "failed")!.reportedBy, [], "nobody reports 'failed': it stays not reported");
});

// =====================================================================================================================================================
// 3. A provider failure is never zero and never fraud, and never removes another courier's answer
// =====================================================================================================================================================
const FAILURES: [string, () => Promise<HistoryAnswer>, string][] = [
  ["auth rejected", async () => ({ ok: false, reason: "auth_failed" }), "auth_failed"],
  ["rate limited by the courier", async () => ({ ok: false, reason: "rate_limited" }), "rate_limited"],
  ["unusable response", async () => ({ ok: false, reason: "invalid_response" }), "invalid_response"],
  ["adapter throws", async () => { throw new Error(`boom ${SECRET} ${PHONE}`); }, "error"],
];
for (const failing of INTEL_PROVIDERS) {
  for (const [label, script, reason] of FAILURES) {
    test(`${failing} fails (${label}) while the other two answer: its row says 'unavailable', the others are untouched, and nothing is read as zero`, async () => {
      const spies = Object.fromEntries(INTEL_PROVIDERS.map((k) => [k, adapter(k, k === failing ? script : undefined)])) as Record<IntelProviderKey, Spy>;
      world(spies);
      const r = await ask();
      const others = INTEL_PROVIDERS.filter((k) => k !== failing);
      const bad = r.reports.find((x) => x.provider === failing)!;
      assert.deepEqual([bad.status, bad.reason], ["unavailable", reason]);
      assert.deepEqual([bad.delivered, bad.cancelled, bad.returned, bad.failed, bad.total, bad.fraudReports], [null, null, null, null, null, null], "no zero stands in for the missing answer");
      for (const k of others) assert.equal(r.reports.find((x) => x.provider === k)!.status, "ok", `${k} unaffected`);
      // combined == exactly the other two
      const delivered = others.reduce((a, k) => a + FIG[k].delivered, 0);
      const cancelled = others.reduce((a, k) => a + FIG[k].cancelled, 0);
      assert.deepEqual(r.combined.contributing, others);
      assert.deepEqual([r.combined.delivered, r.combined.cancelled, r.combined.deliverySuccessRate], [delivered, cancelled, round1((delivered / (delivered + cancelled)) * 100)]);
      assert.deepEqual(r.combined.excluded.map((e) => [e.provider, e.why]), [[failing, "unavailable"]]);
      // stored: the failure is evidence of a failure (nulls), the others carry their own figures
      const badRow = rows().find((x) => x.provider === failing)!;
      assert.deepEqual([badRow.status, badRow.reason, badRow.delivered, badRow.cancelled, badRow.total], ["unavailable", reason, null, null, null]);
      assert.equal(rows().filter((x) => x.status === "ok").length, 2);
    });
  }
}

test("a failure is not fraud: the combined rate with one courier down equals the rate those same couriers give on their own, and trust is identical", async () => {
  world({ steadfast: adapter("steadfast"), pathao: adapter("pathao", async () => ({ ok: false, reason: "timeout" })), redx: null });
  const withFailure = await ask();
  db = freshDb(); resetIntelligenceStateForTests();
  world({ steadfast: adapter("steadfast"), pathao: null, redx: null });
  const alone = await ask();
  assert.equal(withFailure.combined.deliverySuccessRate, alone.combined.deliverySuccessRate);
  const policy = { ...DEFAULT_EVIDENCE_POLICY, minSample: 5 };
  const a = assessTrust({ combined: withFailure.combined, phoneVerified: true, policy });
  const b = assessTrust({ combined: alone.combined, phoneVerified: true, policy });
  assert.deepEqual([a.state, a.rate, a.sample, a.providers, a.rewardAllowed], [b.state, b.rate, b.sample, b.providers, b.rewardAllowed]);
});

test("every courier failing: 'unavailable', no rate, no sample, no penalty and no credit; the outage never moves the decision either way", async () => {
  world({ steadfast: adapter("steadfast", async () => ({ ok: false, reason: "error" })), pathao: adapter("pathao", async () => ({ ok: false, reason: "timeout" })), redx: adapter("redx", async () => { throw new Error("x"); }) });
  const r = await ask();
  assert.deepEqual([r.combined.state, r.combined.deliverySuccessRate, r.combined.delivered, r.combined.cancelled, r.combined.fraudReports], ["unavailable", null, 0, 0, null]);
  const t = assessTrust({ combined: r.combined, phoneVerified: true, policy: { ...DEFAULT_EVIDENCE_POLICY, rewardEnabled: true } });
  assert.deepEqual([t.state, t.rate, t.sample, t.rewardAllowed, t.insufficientEvidence], ["unavailable", null, 0, false, true]);
  assert.match(t.reasons.join(" "), /never lowers the advance/);
  assert.equal(rows().every((x) => x.delivered === null && x.cancelled === null), true);
});

test("'no history' is a real answer (zero) but 'failed' is not: a courier that says 'nothing on record' contributes zero, a failed one contributes nothing", async () => {
  const empty: HistoryAnswer = { ok: true, metrics: { ...EMPTY_METRICS, delivered: 0, cancelled: 0, total: 0, empty: true } };
  world({ steadfast: adapter("steadfast", async () => empty), pathao: adapter("pathao", async () => ({ ok: false, reason: "error" })), redx: null });
  const r = await ask();
  assert.deepEqual(r.reports.map((x) => x.status), ["no_history", "unavailable", "not_configured"]);
  assert.deepEqual(r.combined.contributing, ["steadfast"], "the 'nothing on record' answer counts as an answer");
  assert.deepEqual([r.combined.state, r.combined.deliverySuccessRate], ["no_history", null]);
});

// =====================================================================================================================================================
// 4. Parallel and independent
// =====================================================================================================================================================
test("couriers are queried in parallel: three couriers that each take 200 ms answer in about 200 ms, not 600", async () => {
  const slow = (k: IntelProviderKey) => adapter(k, async () => { await new Promise((r) => setTimeout(r, 200)); return figuresAnswer(k); });
  world({ steadfast: slow("steadfast"), pathao: slow("pathao"), redx: slow("redx") });
  const t0 = Date.now();
  const r = await ask();
  const took = Date.now() - t0;
  assert.ok(r.reports.every((x) => x.status === "ok"));
  assert.ok(took < 450, `took ${took} ms: the lookups must overlap`);
});

test("a courier that never answers times out ALONE: the others' answers are returned, stored and combined, and the checkout is not held open", async () => {
  process.env.FRAUD_CHECK_TIMEOUT_MS = "500";
  world({ steadfast: adapter("steadfast"), pathao: adapter("pathao"), redx: adapter("redx", () => new Promise<HistoryAnswer>(() => undefined)) });
  const t0 = Date.now();
  const r = await ask();
  assert.ok(Date.now() - t0 < 2500);
  assert.deepEqual(r.reports.map((x) => [x.provider, x.status, x.reason]), [["steadfast", "ok", null], ["pathao", "ok", null], ["redx", "unavailable", "timeout"]]);
  assert.deepEqual([r.combined.contributing, r.combined.delivered, r.combined.cancelled], [["steadfast", "pathao"], 15, 5]);
  assert.deepEqual(rows().map((x) => [x.provider, x.status]).sort(), [["pathao", "ok"], ["redx", "unavailable"], ["steadfast", "ok"]]);
});

test("a courier that fails SYNCHRONOUSLY or returns garbage cannot stop the others being asked", async () => {
  const sync: HistoryAdapter = { key: "pathao", lookup: () => { throw new Error("sync boom"); } };
  const garbage: HistoryAdapter = { key: "redx", lookup: async () => "not an answer" as never };
  setIntelligenceDescriptorsForTests({ pathao: mockDescriptor("pathao"), redx: mockDescriptor("redx") });
  setIntelligenceAdaptersForTests({ steadfast: adapter("steadfast"), pathao: sync, redx: garbage } as any);
  const r = await ask();
  assert.deepEqual(r.reports.map((x) => x.status), ["ok", "unavailable", "unavailable"]);
  assert.deepEqual([r.combined.contributing, r.combined.deliverySuccessRate], [["steadfast"], 90]);
});

test("one courier's lookup can be run alone (the admin 'check this courier' path) without touching the others", async () => {
  const spies = { steadfast: adapter("steadfast"), pathao: adapter("pathao"), redx: adapter("redx") };
  world(spies);
  const one = await getProviderReport(PHONE, "pathao", { source: "ADMIN", fresh: true });
  assert.equal(one.report.status, "ok");
  assert.deepEqual([spies.steadfast.calls.length, spies.pathao.calls.length, spies.redx.calls.length], [0, 1, 0]);
  assert.deepEqual(rows().map((x) => x.provider), ["pathao"]);
});

// =====================================================================================================================================================
// 5. Caching, timeouts, budgets: preserved, and per courier
// =====================================================================================================================================================
test("cache: the second lookup of a phone calls NO courier and serves all three from the stored rows; a failed courier alone is asked again after 30 s", async () => {
  let pathaoOk = false;
  const sf = adapter("steadfast"), px = adapter("pathao", async () => (pathaoOk ? figuresAnswer("pathao") : { ok: false, reason: "error" })), rx = adapter("redx");
  world({ steadfast: sf, pathao: px, redx: rx });
  await ask();
  const again = await ask();
  assert.deepEqual([sf.calls.length, px.calls.length, rx.calls.length], [1, 1, 1]);
  assert.ok(again.reports.every((x) => x.cached), "everything came from the shared cache");
  clock += 31_000; // failure memory (30 s) over; successes still cached (10 min)
  pathaoOk = true;
  const later = await ask();
  assert.deepEqual([sf.calls.length, px.calls.length, rx.calls.length], [1, 2, 1], "only the failed courier is asked again");
  assert.deepEqual(later.reports.map((x) => [x.provider, x.status, x.cached]), [["steadfast", "ok", true], ["pathao", "ok", false], ["redx", "ok", true]]);
  assert.equal(later.combined.contributing.length, 3);
});

test("cache: a manual refresh asks every courier again and ADDS rows; a different phone never shares the cache", async () => {
  const spies = { steadfast: adapter("steadfast"), pathao: adapter("pathao"), redx: adapter("redx") };
  world(spies);
  await ask();
  await ask(PHONE, { fresh: true });
  assert.deepEqual(Object.values(spies).map((s) => s.calls.length), [2, 2, 2]);
  assert.equal(rows().length, 6);
  await ask(PHONE2);
  assert.deepEqual(Object.values(spies).map((s) => s.calls.length), [3, 3, 3]);
});

test("cache: a checkout never relies on evidence older than the policy allows, courier by courier", async () => {
  const spies = { steadfast: adapter("steadfast"), pathao: adapter("pathao"), redx: adapter("redx") };
  world(spies);
  await ask();
  clock += 120_000;
  await ask(PHONE, { maxAgeSeconds: 60 });
  assert.deepEqual(Object.values(spies).map((s) => s.calls.length), [2, 2, 2]);
});

test("rate limits are per courier: one courier's used-up budget turns ONLY its lookups into 'rate_limited'", async () => {
  process.env.FRAUD_CHECK_MAX_CALLS_PER_MINUTE = "1";
  const spies = { steadfast: adapter("steadfast"), pathao: adapter("pathao"), redx: adapter("redx") };
  world(spies);
  await getProviderReport(PHONE, "pathao", { source: "ADMIN" }); // spends Pathao's one call this minute
  const r = await ask(PHONE2);
  assert.deepEqual(r.reports.map((x) => [x.provider, x.status, x.reason]), [["steadfast", "ok", null], ["pathao", "unavailable", "rate_limited"], ["redx", "ok", null]]);
  assert.deepEqual([spies.steadfast.calls.length, spies.pathao.calls.length, spies.redx.calls.length], [1, 1, 1], "the refused courier was not called");
  assert.deepEqual([r.combined.contributing, r.combined.delivered], [["steadfast", "redx"], 29]);
  assert.equal(rows().filter((x) => x.phoneHash === hashPhone(PHONE2) && x.provider === "pathao").length, 0, "a refusal says nothing about the courier: not stored");
  clock += 61_000;
  assert.equal((await ask("01911000000")).reports.every((x) => x.status === "ok"), true, "budgets refill");
});

test("timeouts: the configured limit applies to every courier, and a courier slower than it is 'timeout', not a late answer", async () => {
  process.env.FRAUD_CHECK_TIMEOUT_MS = "500";
  const seen: number[] = [];
  const probe = (k: IntelProviderKey): HistoryAdapter => ({ key: k, async lookup(_p, ms) { seen.push(ms); return figuresAnswer(k); } });
  setIntelligenceDescriptorsForTests({ pathao: mockDescriptor("pathao"), redx: mockDescriptor("redx") });
  setIntelligenceAdaptersForTests({ steadfast: probe("steadfast"), pathao: probe("pathao"), redx: probe("redx") } as any);
  await ask();
  assert.deepEqual(seen, [500, 500, 500]);
});

// =====================================================================================================================================================
// 6. Only VERIFIED answers are stored and combined; unsupported metrics are never fabricated
// =====================================================================================================================================================
test("gate through the service: metrics a courier is not documented to report are dropped (not stored, not combined) and flagged without any phone number", async () => {
  const lines: string[] = [];
  const orig = console.warn; console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    // Pathao is documented (mock) for delivered / cancelled / total only, yet claims returned, failed and a rate.
    world({
      steadfast: adapter("steadfast"),
      pathao: adapter("pathao", async () => ({ ok: true, metrics: { ...EMPTY_METRICS, delivered: 6, cancelled: 4, total: 10, returned: 99, failed: 88, reportedDeliveryRate: 60, reportedCancellationRate: 40, empty: false } })),
      redx: null,
    });
    const r = await ask();
    const p = r.reports.find((x) => x.provider === "pathao")!;
    assert.deepEqual([p.status, p.delivered, p.cancelled, p.total], ["ok", 6, 4, 10]);
    assert.deepEqual([p.returned, p.failed, p.reportedDeliveryRate, p.reportedCancellationRate], [null, null, null, null]);
    assert.deepEqual([r.combined.returned, r.combined.failed, r.combined.providerRates], [null, null, []], "the invented figures never reach the combined report");
    const row = rows().find((x) => x.provider === "pathao")!;
    assert.deepEqual([row.returned, row.failed, row.reportedDeliveryRate, row.reportedCancellationRate], [null, null, null, null], "...nor the stored evidence");
  } finally { console.warn = orig; }
  const text = lines.join("\n");
  assert.match(text, /not documented to report/);
  assert.match(text, /"metrics":"returned,failed,deliveryRate,cancellationRate"/, "the drift is flagged with the metric NAMES");
  assert.ok(!text.includes(PHONE) && !text.includes("99"), "the warning names metrics only");
});

test("gate through the service: an implausible or contradictory answer is 'invalid_response' for THAT courier: stored as a failure, never combined, never zero", async () => {
  const bad: HistoryAnswer[] = [
    { ok: true, metrics: { ...EMPTY_METRICS, delivered: 9, cancelled: 9, total: 10, empty: false } }, // total < delivered + cancelled
    { ok: true, metrics: { ...EMPTY_METRICS, delivered: -3, cancelled: 0, total: 0, empty: false } },
    { ok: true, metrics: { ...EMPTY_METRICS, delivered: 2.5, cancelled: 0, total: 3, empty: false } },
    { ok: true, metrics: { ...EMPTY_METRICS, empty: false } }, // nothing at all
    { ok: true, metrics: { ...EMPTY_METRICS, delivered: 4, cancelled: 0, total: 4, empty: true } }, // "no history" but parcels
  ];
  let n = 0;
  for (const answer of bad) {
    db = freshDb(); resetIntelligenceStateForTests();
    world({ steadfast: adapter("steadfast"), pathao: adapter("pathao", async () => answer), redx: null });
    const r = await ask(`01711${String(100000 + n++)}`);
    const p = r.reports.find((x) => x.provider === "pathao")!;
    assert.deepEqual([p.status, p.reason, p.delivered, p.cancelled, p.total], ["unavailable", "invalid_response", null, null, null], JSON.stringify(answer));
    assert.deepEqual([r.combined.contributing, r.combined.delivered, r.combined.cancelled], [["steadfast"], 9, 1]);
    const row = rows().find((x) => x.provider === "pathao")!;
    assert.deepEqual([row.status, row.reason, row.delivered], ["unavailable", "invalid_response", null]);
  }
});

test("an answer with only one of delivered / cancelled is kept as evidence but never combined (the other count is not invented)", async () => {
  world({
    steadfast: adapter("steadfast"),
    pathao: adapter("pathao", async () => ({ ok: true, metrics: { ...EMPTY_METRICS, delivered: 7, total: 7, empty: false } })),
    redx: null,
  });
  const r = await ask();
  assert.equal(r.reports.find((x) => x.provider === "pathao")!.status, "ok");
  assert.deepEqual(r.combined.excluded.map((e) => [e.provider, e.why]), [["pathao", "incomplete_counts"], ["redx", "not_configured"]]);
  assert.deepEqual([r.combined.contributing, r.combined.delivered, r.combined.cancelled], [["steadfast"], 9, 1]);
});

test("an adapter registered under the wrong courier is refused (its answers would be filed under another courier's name)", async () => {
  const lines: string[] = [];
  const orig = console.warn; console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const wrong = adapter("redx");
    setIntelligenceDescriptorsForTests({ pathao: mockDescriptor("pathao"), redx: mockDescriptor("redx") });
    setIntelligenceAdaptersForTests({ steadfast: adapter("steadfast"), pathao: wrong as any, redx: null } as any);
    const r = await ask();
    assert.equal(r.reports.find((x) => x.provider === "pathao")!.status, "not_configured");
    assert.equal(wrong.calls.length, 0);
    assert.deepEqual([...new Set(rows().map((x) => x.provider))], ["steadfast"]);
  } finally { console.warn = orig; }
  assert.match(lines.join("\n"), /adapter key does not match/);
});

test("the stored view (no courier call) reports each courier's newest stored answer and lists a never-checked one as 'unchecked', not as zero or failed", async () => {
  const spies = { steadfast: adapter("steadfast"), pathao: adapter("pathao"), redx: adapter("redx") };
  world(spies);
  await getProviderReport(PHONE, "steadfast", { source: "ADMIN" });
  await getProviderReport(PHONE, "redx", { source: "ADMIN" });
  const before = Object.values(spies).map((s) => s.calls.length);
  const view = await getStoredIntelligence(PHONE);
  assert.deepEqual(Object.values(spies).map((s) => s.calls.length), before, "opening the view calls nobody");
  assert.deepEqual(view.unchecked, ["pathao"]);
  assert.deepEqual(view.combined.contributing, ["steadfast", "redx"]);
  assert.deepEqual([view.combined.delivered, view.combined.cancelled], [29, 6]);
});

// =====================================================================================================================================================
// 7. Privacy: no raw phone and no credential in logs, results, or stored rows, whatever the courier mix
// =====================================================================================================================================================
test("no raw phone number or credential leaks into logs, stored rows or results across failing, throwing, rate-limited and gated lookups for all three couriers", async () => {
  process.env.FRAUD_CHECK_MAX_CALLS_PER_MINUTE = "4";
  const lines: string[] = [];
  const orig = { w: console.warn, e: console.error, i: console.info, l: console.log };
  console.warn = console.error = console.info = console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const results: unknown[] = [];
  try {
    world({
      steadfast: adapter("steadfast", async (p) => { throw new Error(`${SECRET} ${p} https://x.example/fraud_check/${p}`); }),
      pathao: adapter("pathao", async () => ({ ok: false, reason: "auth_failed" })),
      redx: adapter("redx", async () => ({ ok: true, metrics: { ...EMPTY_METRICS, delivered: 1, cancelled: 0, total: 1, returned: 5, failed: 6, empty: false } })), // 'failed' is not in the REDX mock's metrics: gated, and flagged in the log
    });
    results.push(await ask(PHONE));
    results.push(await ask(PHONE2, { fresh: true }));
    for (let i = 0; i < 3; i++) results.push(await ask(`0191100000${i}`)); // exhausts the small budget
    world({ steadfast: adapter("steadfast"), pathao: adapter("pathao", async () => ({ ok: true, metrics: { ...EMPTY_METRICS, delivered: 3, cancelled: 0, total: 3, failed: 7, empty: false } })), redx: null });
    results.push(await ask("01611000000", { fresh: true }));
  } finally { console.warn = orig.w; console.error = orig.e; console.info = orig.i; console.log = orig.l; }
  const text = lines.join("\n");
  assert.ok(lines.length > 0, "something was logged");
  const everything = text + JSON.stringify(results) + JSON.stringify(rows());
  for (const raw of [PHONE, PHONE2, "01911000000", "01911000001", "01911000002", "01611000000", SECRET, "fraud_check/"]) assert.ok(!everything.includes(raw), `${raw} leaked`);
  assert.ok(text.includes("017*****000"), "only the masked form is logged");
  assert.ok(rows().every((x) => x.phoneHash !== x.phoneMasked && /^[0-9a-f]{64}$/.test(x.phoneHash)));
});
