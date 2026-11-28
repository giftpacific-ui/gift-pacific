import type { CombinedReport } from "@/lib/courier-intelligence/combine";
import { providerDescriptor } from "@/lib/courier-intelligence/registry";
import { describeMetricCoverage, METRIC_LABEL, unreportedMetrics, type MissingWhy } from "@/lib/courier-intelligence/coverage";
import { FAILURE_TEXT, INTEL_PROVIDERS, type IntelProviderKey, type MetricName, type ProviderReport } from "@/lib/courier-intelligence/types";

/**
 * The data the admin screens show for courier delivery history, built in ONE place (pure; client-safe; no I/O, no decisions) so the Fraud Checker,
 * the order page and the tests all read exactly the same numbers and warnings. Rules it enforces:
 *   - a count a courier did not report is "not reported", never 0;
 *   - when NO courier answered, the combined counts are "no data", never 0 (a failure must not read as "zero deliveries");
 *   - a courier that is unsupported, not configured, unavailable or not yet checked always produces a visible warning that says it adds nothing
 *     to the combined result and is not a sign of fraud.
 */

export function freshness(checkedAt: string, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(checkedAt)) / 1000));
  if (!Number.isFinite(s)) return "unknown time";
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Which couriers the admin screens show and ask. A courier with a documented history lookup is always shown. A courier WITHOUT one (today Pathao and
 * REDX) is not shown and not asked at all: nothing is queried and nothing can be reported for it, so it neither appears as a card nor as a warning.
 * (If a report says a courier really answered or failed it is shown whatever its registry entry says, so a courier added later appears by itself.)
 */
export const displayedProviders = (): IntelProviderKey[] => INTEL_PROVIDERS.filter((p) => providerDescriptor(p).capability === "supported");
export function isDisplayedProvider(provider: IntelProviderKey, report: ProviderReport | null): boolean {
  return report ? report.status !== "unsupported" : providerDescriptor(provider).capability === "supported";
}

export type CountView = { value: number | null; text: string; note: string | null };
export type WarningKind = "unsupported" | "not_configured" | "unavailable" | "not_checked";
export type ProviderWarning = { provider: IntelProviderKey; label: string; kind: WarningKind; severity: "info" | "warn"; text: string };
export type CardTone = "ok" | "neutral" | "warn";
export type CardStatus = ProviderReport["status"] | "not_checked";

export type ProviderCardView = {
  provider: IntelProviderKey;
  label: string;
  status: CardStatus;
  statusLabel: string;
  tone: CardTone;
  /** true when the courier gave an answer with figures (answered, or "nothing on record"). */
  hasCounts: boolean;
  counts: { delivered: CountView; cancelled: CountView; returned: CountView; failed: CountView; total: CountView; fraudReports: CountView } | null;
  providerRates: { delivery: number | null; cancellation: number | null } | null;
  checkedAt: string | null;
  checkedAgo: string | null;
  checkedUtc: string | null;
  source: "cached" | "fresh" | null;
  sourceLabel: string | null;
  warning: ProviderWarning | null;
  semantics: string | null;
};

const STATUS: Record<CardStatus, { label: string; tone: CardTone }> = {
  ok: { label: "Answered", tone: "ok" },
  no_history: { label: "No history on record", tone: "neutral" },
  unavailable: { label: "Unavailable", tone: "warn" },
  not_configured: { label: "Not configured", tone: "neutral" },
  unsupported: { label: "Not supported", tone: "neutral" },
  not_checked: { label: "Not checked", tone: "neutral" },
};

const NOT_JUDGED = "It adds nothing to the combined result and is not a sign of fraud.";

export function providerWarning(provider: IntelProviderKey, status: CardStatus, reason: ProviderReport["reason"]): ProviderWarning | null {
  const d = providerDescriptor(provider);
  const base = { provider, label: d.label };
  if (status === "unsupported") return { ...base, kind: "unsupported", severity: "info", text: `${d.label} is not supported: ${d.summary} ${NOT_JUDGED}` };
  if (status === "not_configured") return { ...base, kind: "not_configured", severity: "info", text: `${d.label} is not configured. ${d.summary} ${NOT_JUDGED}` };
  if (status === "unavailable") {
    return { ...base, kind: "unavailable", severity: "warn", text: `${d.label} is unavailable: ${reason ? FAILURE_TEXT[reason] : "no answer"}. Nothing was assumed: it is not counted as zero deliveries and is not treated as a sign of fraud.` };
  }
  if (status === "not_checked") return { ...base, kind: "not_checked", severity: "info", text: `${d.label} has not been checked for this phone yet.` };
  return null;
}

function count(provider: IntelProviderKey, metric: MetricName, value: number | null): CountView {
  if (value !== null) return { value, text: String(value), note: null };
  const d = providerDescriptor(provider);
  return { value: null, text: "not reported", note: d.capability === "supported" && d.unsupportedMetrics.includes(metric) ? `${d.label} does not report this figure` : null };
}

export function buildProviderCardView(provider: IntelProviderKey, report: ProviderReport | null, nowMs: number = Date.now()): ProviderCardView {
  const d = providerDescriptor(provider);
  const status: CardStatus = report ? report.status : "not_checked";
  const st = STATUS[status];
  const hasCounts = !!report && (report.status === "ok" || report.status === "no_history");
  const lookedUp = !!report && report.status !== "unsupported" && report.status !== "not_configured";
  const r = report;
  return {
    provider, label: d.label, status, statusLabel: st.label, tone: st.tone, hasCounts,
    counts: r && hasCounts
      ? {
          delivered: count(provider, "delivered", r.delivered), cancelled: count(provider, "cancelled", r.cancelled), returned: count(provider, "returned", r.returned),
          failed: count(provider, "failed", r.failed), total: count(provider, "total", r.total), fraudReports: count(provider, "fraudReports", r.fraudReports),
        }
      : null,
    providerRates: r && hasCounts && (r.reportedDeliveryRate !== null || r.reportedCancellationRate !== null) ? { delivery: r.reportedDeliveryRate, cancellation: r.reportedCancellationRate } : null,
    checkedAt: r && lookedUp ? r.checkedAt : null,
    checkedAgo: r && lookedUp ? freshness(r.checkedAt, nowMs) : null,
    checkedUtc: r && lookedUp ? utc(r.checkedAt) : null,
    source: r && lookedUp ? (r.cached ? "cached" : "fresh") : null,
    sourceLabel: r && lookedUp ? (r.cached ? "from the saved result" : "fresh from the courier") : null,
    warning: providerWarning(provider, status, r?.reason ?? null),
    semantics: hasCounts ? d.semantics : null,
  };
}

export type CombinedView = {
  state: CombinedReport["state"];
  headline: string;
  rate: number | null;
  /** At least one courier gave an answer. When false every combined count reads "no data": never 0. */
  hasData: boolean;
  delivered: CountView; cancelled: CountView; returned: CountView; failed: CountView; fraudReports: CountView; countedInRate: CountView; notClassified: CountView;
  couriers: string[];
  excluded: string[];
  notes: string[];
};

export type FreshnessKind = "fresh" | "cached" | "mixed" | "none";
export type HistoryView = {
  /** The displayed couriers in a fixed order (see isDisplayedProvider). A displayed courier with no report yet is "not checked". */
  cards: ProviderCardView[];
  combined: CombinedView;
  lastCheckedAt: string | null;
  lastCheckedText: string | null;
  oldestCheckedAt: string | null;
  freshness: FreshnessKind;
  freshnessLabel: string;
  warnings: ProviderWarning[];
  /** Shown when no courier contributed: says that this alone never rejects or penalises an order. */
  noDataNotice: string | null;
  unreported: { metric: MetricName; label: string; reasons: string[] }[];
};

const MISSING_TEXT: Record<MissingWhy, string> = {
  unsupported_by_courier: "the courier does not report it",
  no_answer: "no usable answer this time, so it is unknown (not zero)",
  not_in_answer: "left out of its answer",
};
const FRESHNESS_LABEL: Record<FreshnessKind, string> = {
  fresh: "Fresh from the couriers", cached: "From saved results", mixed: "Some saved, some fresh", none: "No courier lookup yet",
};

export function buildHistoryView(reports: readonly ProviderReport[], combined: CombinedReport, nowMs: number = Date.now()): HistoryView {
  const cards = INTEL_PROVIDERS
    .filter((p) => isDisplayedProvider(p, reports.find((r) => r.provider === p) ?? null))
    .map((p) => buildProviderCardView(p, reports.find((r) => r.provider === p) ?? null, nowMs));
  const hasData = combined.contributing.length > 0;
  const noData = (note: string | null = null): CountView => ({ value: null, text: "no data", note: note ?? "no courier gave an answer" });
  const figure = (v: number | null): CountView => (!hasData ? noData() : v === null ? { value: null, text: "not reported", note: null } : { value: v, text: String(v), note: null });

  const looked = cards.filter((c) => c.checkedAt !== null);
  const times = looked.map((c) => c.checkedAt as string).sort();
  const sources = new Set(looked.map((c) => c.source));
  const kind: FreshnessKind = looked.length === 0 ? "none" : sources.size > 1 ? "mixed" : sources.has("cached") ? "cached" : "fresh";
  const last = times.length ? times[times.length - 1] : null;

  const warnings = cards.map((c) => c.warning).filter((w): w is ProviderWarning => w !== null);
  const unreported = unreportedMetrics(describeMetricCoverage(reports)).map((u) => ({
    metric: u.metric, label: METRIC_LABEL[u.metric], reasons: [...new Set(u.missing.map((m) => MISSING_TEXT[m.why]))],
  }));
  const headline =
    combined.state === "valid" ? `${combined.deliverySuccessRate}% combined delivery success`
    : combined.state === "no_history" ? "No delivery history on record"
    : combined.state === "insufficient" ? "Not enough comparable data for a combined rate"
    : "No courier data available";

  return {
    cards,
    combined: {
      state: combined.state, headline, rate: combined.state === "valid" ? combined.deliverySuccessRate : null, hasData,
      delivered: figure(combined.delivered), cancelled: figure(combined.cancelled), returned: figure(combined.returned), failed: figure(combined.failed),
      fraudReports: figure(combined.fraudReports), countedInRate: figure(combined.finalOutcomes), notClassified: figure(combined.notClassified),
      couriers: combined.contributing.map((p) => providerDescriptor(p).label), excluded: combined.excluded.filter((e) => e.why !== "unsupported").map((e) => e.detail), notes: combined.notes,
    },
    lastCheckedAt: last, lastCheckedText: last ? `${freshness(last, nowMs)} (${utc(last)})` : null, oldestCheckedAt: times[0] ?? null,
    freshness: kind, freshnessLabel: FRESHNESS_LABEL[kind], warnings,
    noDataNotice: hasData ? null : "No courier delivery history is available for this phone. That alone never rejects or penalises an order: it is simply missing information.",
    unreported,
  };
}
