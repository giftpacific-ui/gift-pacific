/**
 * The data the Fraud Checker and the order page DISPLAY (lib/courier-intelligence/view.ts and lib/fraud/risk-view.ts). Pure: reports in, display data
 * out. These are the tests for "UI data": what each screen can show cannot differ from what is asserted here, because the components render only this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { combineReports } from "@/lib/courier-intelligence/combine";
import { buildHistoryView, buildProviderCardView, displayedProviders, freshness, isDisplayedProvider } from "@/lib/courier-intelligence/view";
import { readFileSync } from "node:fs";
import { buildRiskView, COURIER_SIGNAL_CODE, highestLevel, type RiskPanelInput } from "@/lib/fraud/risk-view";
import { EMPTY_METRICS, INTEL_PROVIDERS, type IntelProviderKey, type ProviderReport } from "@/lib/courier-intelligence/types";
import { RATE_LIMITS } from "@/lib/rate-limit";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const rep = (provider: IntelProviderKey, o: Partial<ProviderReport> = {}): ProviderReport => ({
  provider, status: "ok", reason: null, checkedAt: ago(30), cached: false, ...EMPTY_METRICS, ...o,
});
const ok = (p: IntelProviderKey, delivered: number, cancelled: number, o: Partial<ProviderReport> = {}) => rep(p, { delivered, cancelled, total: delivered + cancelled, ...o });
const view = (reports: ProviderReport[]) => buildHistoryView(reports, combineReports(reports), NOW);
// Steadfast answered; Pathao and REDX are unsupported (the real production situation)
const production = (sf: ProviderReport) => [sf, rep("pathao", { status: "unsupported", checkedAt: ago(0) }), rep("redx", { status: "unsupported", checkedAt: ago(0) })];

// ---- one card per courier: Steadfast, Pathao, RedX --------------------------------------------------------------------------------------------
test("history view: only couriers with a history lookup are shown (today Steadfast); a displayed courier with no report yet is 'not checked'", () => {
  const v = buildHistoryView([], combineReports([]), NOW);
  assert.deepEqual(v.cards.map((c) => [c.provider, c.status, c.label]), [["steadfast", "not_checked", "Steadfast"]]);
  const withRedx = buildHistoryView([ok("redx", 5, 1)], combineReports([ok("redx", 5, 1)]), NOW);
  assert.deepEqual(withRedx.cards.map((c) => [c.provider, c.status]), [["steadfast", "not_checked"], ["redx", "ok"]], "a courier that really answered is shown, whatever the registry says");
});

test("display filter: unsupported couriers are neither asked nor shown; a courier that really answered or failed is shown", () => {
  assert.deepEqual(displayedProviders(), ["steadfast"]);
  assert.equal(isDisplayedProvider("steadfast", null), true);
  assert.equal(isDisplayedProvider("pathao", null), false);
  assert.equal(isDisplayedProvider("redx", rep("redx", { status: "unsupported" })), false);
  for (const status of ["ok", "no_history", "unavailable", "not_configured"] as const) assert.equal(isDisplayedProvider("pathao", rep("pathao", { status })), true, status);
});

test("display: with Pathao and REDX unsupported the view has no card, no warning and no excluded line that mentions them", () => {
  const v = view(production(ok("steadfast", 9, 1, { fraudReports: 0 })));
  assert.deepEqual(v.cards.map((c) => c.provider), ["steadfast"]);
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(v.combined.excluded, []);
  assert.ok(!/pathao|redx/i.test(JSON.stringify(v)), "nothing in the display data names them");
  assert.deepEqual([v.combined.rate, v.combined.couriers], [90, ["Steadfast"]], "the combined result is unchanged");
});

test("the Fraud Checker only asks the displayed couriers (it never iterates the full provider list)", () => {
  const src = readFileSync(new URL("../../src/features/admin/fraud-check-client.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /INTEL_PROVIDERS/);
  assert.match(src, /const ASKED: IntelProviderKey\[\] = displayedProviders\(\);/);
  assert.doesNotMatch(src, /pathao|redx/i);
});

test("card: an answering courier shows delivered, cancelled, returned, failed, total and fraud reports; a count the courier does not report is 'not reported', never 0", () => {
  const c = buildProviderCardView("steadfast", ok("steadfast", 9, 1, { fraudReports: 0 }), NOW);
  assert.equal(c.hasCounts, true);
  assert.deepEqual([c.counts!.delivered.text, c.counts!.cancelled.text, c.counts!.total.text, c.counts!.fraudReports.text], ["9", "1", "10", "0"]);
  assert.deepEqual([c.counts!.returned.value, c.counts!.returned.text, c.counts!.failed.value, c.counts!.failed.text], [null, "not reported", null, "not reported"]);
  assert.match(c.counts!.returned.note ?? "", /Steadfast does not report this figure/, "says WHY it is missing");
  assert.equal(c.counts!.delivered.note, null);
  assert.equal(c.warning, null);
});

test("card: a genuine zero is shown as 0 (a courier saying 'nothing on record' is an answer), unlike 'not reported'", () => {
  const c = buildProviderCardView("steadfast", rep("steadfast", { status: "no_history", delivered: 0, cancelled: 0, total: 0 }), NOW);
  assert.deepEqual([c.status, c.statusLabel, c.counts!.delivered.text, c.counts!.delivered.value], ["no_history", "No history on record", "0", 0]);
});

test("card: last checked, and cached or fresh, are stated for every courier that was really asked", () => {
  const fresh = buildProviderCardView("steadfast", ok("steadfast", 1, 0, { checkedAt: ago(30), cached: false }), NOW);
  assert.deepEqual([fresh.source, fresh.sourceLabel, fresh.checkedAgo, fresh.checkedUtc], ["fresh", "fresh from the courier", "just now", "2026-11-24 11:59 UTC"]);
  const cached = buildProviderCardView("steadfast", ok("steadfast", 1, 0, { checkedAt: ago(3600), cached: true }), NOW);
  assert.deepEqual([cached.source, cached.sourceLabel, cached.checkedAgo], ["cached", "from the saved result", "60 min ago"]);
  const failed = buildProviderCardView("steadfast", rep("steadfast", { status: "unavailable", reason: "timeout", checkedAt: ago(120), cached: true }), NOW);
  assert.deepEqual([failed.source, failed.checkedAgo], ["cached", "2 min ago"], "a failed lookup also says when it was tried");
});

test("card: unsupported / not configured / not checked have NO counts, NO checked time and no cached-or-fresh claim (nothing was asked)", () => {
  for (const status of ["unsupported", "not_configured"] as const) {
    const c = buildProviderCardView("pathao", rep("pathao", { status, checkedAt: ago(5) }), NOW);
    assert.deepEqual([c.counts, c.checkedAt, c.checkedAgo, c.source, c.hasCounts], [null, null, null, null, false], status);
  }
  const none = buildProviderCardView("redx", null, NOW);
  assert.deepEqual([none.status, none.statusLabel, none.counts, none.checkedAt], ["not_checked", "Not checked", null, null]);
});

test("card: provider-reported rates are shown but flagged as not combined; absent when the courier gave none", () => {
  assert.deepEqual(buildProviderCardView("redx", ok("redx", 1, 0, { reportedDeliveryRate: 90, reportedCancellationRate: 10 }), NOW).providerRates, { delivery: 90, cancellation: 10 });
  assert.equal(buildProviderCardView("redx", ok("redx", 1, 0), NOW).providerRates, null);
});

// ---- warnings -------------------------------------------------------------------------------------------------------------------------------
test("warnings: an unavailable Steadfast is a WARNING that says it was not counted as zero; unsupported couriers produce none", () => {
  const v = view([rep("steadfast", { status: "unavailable", reason: "timeout" }), rep("pathao", { status: "unsupported" }), rep("redx", { status: "unsupported" })]);
  assert.deepEqual(v.warnings.map((w) => [w.provider, w.kind, w.severity]), [["steadfast", "unavailable", "warn"]]);
  const sf = v.warnings[0].text;
  assert.match(sf, /Steadfast is unavailable: The courier did not answer in time/);
  assert.match(sf, /not counted as zero deliveries and is not treated as a sign of fraud/);
});

test("the warning text for an unsupported courier still exists for direct use (it is just not shown on the admin screens)", () => {
  const w = buildProviderCardView("pathao", rep("pathao", { status: "unsupported" }), NOW).warning!;
  assert.deepEqual([w.kind, w.severity], ["unsupported", "info"]);
  assert.match(w.text, /not a sign of fraud/);
});

test("warnings: every failure reason is spelled out; not configured and not checked are informational; a healthy answer has none", () => {
  const reasons = ["disabled", "invalid_phone", "timeout", "error", "invalid_response", "rate_limited", "auth_failed"] as const;
  for (const reason of reasons) {
    const w = view([rep("steadfast", { status: "unavailable", reason })]).warnings.find((x) => x.provider === "steadfast")!;
    assert.equal(w.severity, "warn", reason);
    assert.match(w.text, /Nothing was assumed/);
  }
  assert.equal(view([rep("steadfast", { status: "not_configured" })]).warnings.find((x) => x.provider === "steadfast")!.severity, "info");
  assert.deepEqual(view([ok("steadfast", 9, 1)]).warnings, [], "a healthy Steadfast raises no warning, and the hidden couriers none either");
  assert.deepEqual(view([]).warnings.map((w) => [w.provider, w.kind, w.severity]), [["steadfast", "not_checked", "info"]]);
  assert.deepEqual(view([rep("pathao", { status: "unavailable", reason: "error" })]).warnings.map((w) => w.provider), ["steadfast", "pathao"], "a courier that really failed is warned about");
});

// ---- combined verified statistics -----------------------------------------------------------------------------------------------------------
test("combined: verified totals, the rate, which couriers contributed, and returned / failed kept out of the rate", () => {
  const v = view(production(ok("steadfast", 9, 1, { fraudReports: 0 })));
  assert.deepEqual([v.combined.rate, v.combined.headline, v.combined.hasData], [90, "90% combined delivery success", true]);
  assert.deepEqual([v.combined.delivered.text, v.combined.cancelled.text, v.combined.countedInRate.text, v.combined.couriers], ["9", "1", "10", ["Steadfast"]]);
  assert.deepEqual([v.combined.returned.text, v.combined.failed.text], ["not reported", "not reported"]);
  assert.equal(v.noDataNotice, null);
  assert.deepEqual(v.combined.excluded, [], "unsupported couriers are not listed");
});

test("REGRESSION: when NO courier answered, combined counts read 'no data', never 0 (a failure is not 'zero deliveries and zero cancellations')", () => {
  const v = view([rep("steadfast", { status: "unavailable", reason: "error" }), rep("pathao", { status: "unsupported" }), rep("redx", { status: "unsupported" })]);
  assert.equal(v.combined.hasData, false);
  for (const k of ["delivered", "cancelled", "returned", "failed", "fraudReports", "countedInRate", "notClassified"] as const) {
    assert.deepEqual([v.combined[k].value, v.combined[k].text], [null, "no data"], k);
  }
  assert.equal(v.combined.rate, null);
  assert.match(v.combined.headline, /No courier data available/);
  assert.match(v.noDataNotice ?? "", /never rejects or penalises an order/);
});

test("a courier saying 'nothing on record' is real data: the combined counts are a true 0 and there is NO 'no data' notice", () => {
  const v = view(production(rep("steadfast", { status: "no_history", delivered: 0, cancelled: 0, total: 0 })));
  assert.deepEqual([v.combined.hasData, v.combined.delivered.value, v.combined.cancelled.value, v.noDataNotice, v.combined.headline], [true, 0, 0, null, "No delivery history on record"]);
});

test("combined: an incomplete or percentage-only answer is excluded and the headline says a rate cannot be calculated", () => {
  const v = view([rep("steadfast", { delivered: 8 }), rep("pathao", { status: "unsupported" }), rep("redx", { status: "unsupported" })]);
  assert.equal(v.combined.rate, null);
  assert.equal(v.combined.state, "insufficient");
  assert.match(v.combined.excluded.join(" "), /only some of the delivered \/ cancelled counts/);
});

test("combined: the unreported metrics and why (Steadfast gives no returned / failed counts; nobody gives a rate)", () => {
  const v = view(production(ok("steadfast", 9, 1, { fraudReports: 0 })));
  const byLabel = Object.fromEntries(v.unreported.map((u) => [u.label, u.reasons]));
  assert.deepEqual(Object.keys(byLabel).sort(), ["Cancellation rate", "Delivery rate", "Failed", "Returned"]);
  assert.deepEqual(byLabel.Returned, ["the courier does not report it"]);
});

// ---- last checked, cached / fresh --------------------------------------------------------------------------------------------------------------
test("freshness: all fresh, all cached, mixed, and none are labelled; 'last checked' is the NEWEST lookup and 'oldest' the oldest", () => {
  const f = view([ok("steadfast", 1, 0, { checkedAt: ago(10), cached: false })]);
  assert.deepEqual([f.freshness, f.freshnessLabel, f.lastCheckedAt, f.oldestCheckedAt], ["fresh", "Fresh from the couriers", ago(10), ago(10)]);
  const c = view([ok("steadfast", 1, 0, { checkedAt: ago(600), cached: true })]);
  assert.deepEqual([c.freshness, c.freshnessLabel], ["cached", "From saved results"]);
  const m = view([ok("steadfast", 1, 0, { checkedAt: ago(10), cached: false }), ok("redx", 1, 0, { checkedAt: ago(900), cached: true })]);
  assert.deepEqual([m.freshness, m.freshnessLabel, m.lastCheckedAt, m.oldestCheckedAt], ["mixed", "Some saved, some fresh", ago(10), ago(900)]);
  assert.match(m.lastCheckedText ?? "", /^just now \(2026-11-24 11:59 UTC\)$/);
  const none = view(production(rep("steadfast", { status: "not_configured" })));
  assert.deepEqual([none.freshness, none.lastCheckedAt, none.lastCheckedText, none.freshnessLabel], ["none", null, null, "No courier lookup yet"]);
});

test("freshness helper: just now, minutes, hours, days, and an unreadable time", () => {
  assert.deepEqual([freshness(ago(5), NOW), freshness(ago(600), NOW), freshness(ago(7200), NOW), freshness(ago(3 * 86400), NOW), freshness("not a date", NOW)], ["just now", "10 min ago", "2 h ago", "3 days ago", "unknown time"]);
});

// ---- all three couriers answering (mock) --------------------------------------------------------------------------------------------------
test("with all three couriers answering (mock) the view lists each courier's own counts and one combined total", () => {
  const reports = [ok("steadfast", 9, 1), ok("pathao", 6, 4), ok("redx", 20, 5, { returned: 3 })];
  const v = view(reports);
  assert.deepEqual(v.cards.map((c) => [c.label, c.counts!.delivered.text, c.counts!.cancelled.text]), [["Steadfast", "9", "1"], ["Pathao", "6", "4"], ["REDX", "20", "5"]]);
  assert.deepEqual([v.combined.delivered.text, v.combined.cancelled.text, v.combined.returned.text, v.combined.rate, v.combined.couriers], ["35", "10", "3", 77.8, ["Steadfast", "Pathao", "REDX"]]);
  assert.deepEqual(v.warnings, []);
});

test("the view never carries a phone number, a credential or a raw provider payload (only normalised reports go in, only display strings come out)", () => {
  const text = JSON.stringify(view(production(ok("steadfast", 9, 1))));
  assert.ok(!/\b01[3-9]\d{8}\b/.test(text));
  assert.ok(!/api[-_ ]?key|secret|token/i.test(text));
});

// ---- customer risk score and reasons ------------------------------------------------------------------------------------------------------
const panel = (o: Partial<RiskPanelInput> = {}): RiskPanelInput => ({
  mode: "ENFORCE", assessed: true, score: 62, level: "HIGH", assessedAt: new Date("2026-11-24T10:00:00Z"),
  signals: [
    { code: "PRIOR_CANCELLED", label: "Earlier cancelled orders", points: 16, detail: "2 earlier orders cancelled" },
    { code: "PHONE_BURST", label: "Many orders from one phone", points: 30, detail: "4 other orders", refs: ["GP-1", "GP-2"] },
    { code: "DELIVERED_KNOWN_ADDRESS", label: "Delivered to this address before", points: -8, detail: "delivered" },
    { code: "ZERO", label: "No effect", points: 0, detail: "ignored" },
  ],
  ...o,
});

test("risk view: score, level, calculated time; reasons that RAISE the score first (strongest first), then credits; zero-point signals are dropped", () => {
  const r = buildRiskView(panel(), 1);
  assert.deepEqual([r.assessed, r.score, r.level, r.levelLabel, r.assessedAt], [true, 62, "HIGH", "High risk", "2026-11-24T10:00:00.000Z"]);
  assert.deepEqual(r.reasons.map((x) => [x.code, x.points, x.direction]), [["PHONE_BURST", 30, "raises"], ["PRIOR_CANCELLED", 16, "raises"], ["DELIVERED_KNOWN_ADDRESS", -8, "lowers"]]);
  assert.deepEqual(r.reasons[0].refs, ["GP-1", "GP-2"]);
});

test("risk view: the compact list is capped and says how many more there are", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ code: `S${i}`, label: `S${i}`, points: 10 - i, detail: "d" }));
  const r = buildRiskView(panel({ signals: many }), 1, { maxShown: 4 });
  assert.deepEqual([r.reasons.length, r.shown.length, r.hiddenCount], [9, 4, 5]);
  assert.equal(buildRiskView(panel(), 1).hiddenCount, 0);
});

test("risk view courier note: courier history is credited with a raise ONLY when the stored low-trust signal exists", () => {
  const withCourier = buildRiskView(panel({ signals: [{ code: COURIER_SIGNAL_CODE, label: "Low courier trust", points: 20, detail: "low" }] }), 2);
  assert.match(withCourier.courierNote, /Courier delivery history raised this score by 20/);
  assert.match(buildRiskView(panel(), 2).courierNote, /did not raise this score/);
});

test("REGRESSION guard: with no courier answer the note says it is NOT counted and never raises the score or rejects an order", () => {
  const r = buildRiskView(panel({ signals: [{ code: "PHONE_BURST", label: "x", points: 5, detail: "d" }] }), 0);
  assert.match(r.courierNote, /No courier history was available, so it is not counted in this score/);
  assert.match(r.courierNote, /never raises the score and never rejects an order/);
  assert.equal(r.reasons.some((x) => x.code === COURIER_SIGNAL_CODE), false);
});

test("risk view: not assessed / OFF / no panel are honest 'not assessed', never a made-up score", () => {
  for (const p of [null, panel({ assessed: false, score: null, level: null }), panel({ mode: "OFF", assessed: false, score: null, level: null, signals: [] })]) {
    const r = buildRiskView(p, null);
    assert.deepEqual([r.assessed, r.score, r.level, r.levelLabel, r.reasons], [false, null, null, "Not assessed", []]);
  }
  assert.match(buildRiskView(null, null).courierNote, /No risk score has been calculated/);
});

test("risk view: the disclaimer says it is evidence, not a verdict, and that a missing courier answer is never counted against the customer", () => {
  assert.match(buildRiskView(panel(), 1).disclaimer, /not a verdict/);
  assert.match(buildRiskView(panel(), 1).disclaimer, /never counted against the customer/);
});

test("highest level helper picks the most severe", () => {
  assert.equal(highestLevel(["LOW", "CRITICAL", "MEDIUM", null]), "CRITICAL");
  assert.equal(highestLevel([null, null]), null);
});

// ---- rate-limit rules for the manual rechecks ----------------------------------------------------------------------------------------------
test("rate-limit rules: order rechecks 20/hour/admin; phone lookups 90/hour/admin; one refresh per admin+courier+phone every 30 s; risk lookups bounded", () => {
  assert.deepEqual([RATE_LIMITS.fraudRecheck.limit, RATE_LIMITS.fraudRecheck.windowSeconds], [20, 3600]);
  assert.deepEqual([RATE_LIMITS.courierLookupAdmin.limit, RATE_LIMITS.courierLookupAdmin.windowSeconds], [90, 3600]);
  assert.deepEqual([RATE_LIMITS.courierRefreshPhone.limit, RATE_LIMITS.courierRefreshPhone.windowSeconds], [1, 30]);
  assert.deepEqual([RATE_LIMITS.riskLookupAdmin.limit, RATE_LIMITS.riskLookupAdmin.windowSeconds], [180, 3600]);
  const names = Object.values(RATE_LIMITS).map((r) => r.name);
  assert.equal(new Set(names).size, names.length, "every rule has its own bucket name");
});

test("sanity: the three couriers are exactly steadfast, pathao, redx", () => {
  assert.deepEqual([...INTEL_PROVIDERS], ["steadfast", "pathao", "redx"]);
});
