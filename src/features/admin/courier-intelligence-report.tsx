import type { CombinedReport } from "@/lib/courier-intelligence/combine";
import { combineReports } from "@/lib/courier-intelligence/combine";
import type { IntelProviderKey, ProviderReport } from "@/lib/courier-intelligence/types";
import { buildHistoryView, buildProviderCardView, freshness, type CardTone, type CountView, type HistoryView, type ProviderCardView } from "@/lib/courier-intelligence/view";
import { cn } from "@/lib/utils";

export { freshness };

/**
 * Presentation only: no data fetching, no decisions. Every figure, label and warning comes from lib/courier-intelligence/view.ts (the same
 * module the tests exercise), so the screen cannot show a number the view-model did not produce.
 */
const TONE: Record<CardTone, string> = { ok: "bg-emerald-50 text-emerald-900", neutral: "bg-secondary text-muted-foreground", warn: "bg-amber-50 text-amber-900" };

function Count({ label, c }: { label: string; c: CountView }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium", c.value === null && "text-muted-foreground")} title={c.note ?? undefined}>{c.text}</dd>
    </div>
  );
}

/** `showWarning`: set false where a ProviderWarnings block is shown next to the cards, so each warning appears once. */
export function ProviderReportCard({ provider, report, checking, showWarning = true }: { provider: IntelProviderKey; report: ProviderReport | null; checking?: boolean; showWarning?: boolean }) {
  const v = buildProviderCardView(provider, report);
  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-card p-3 text-sm" data-provider-card data-provider={provider} data-status={v.status}>
      <ProviderBody v={v} checking={checking} showWarning={showWarning} />
    </div>
  );
}

function ProviderBody({ v, checking, showWarning }: { v: ProviderCardView; checking?: boolean; showWarning: boolean }) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{v.label} delivery history</span>
        <span className={cn("rounded-full px-2 py-0.5 text-xs", TONE[v.tone])}>{checking ? "Checking…" : v.statusLabel}</span>
      </div>
      {showWarning && v.warning && <p className={cn("text-xs", v.warning.severity === "warn" ? "text-amber-900" : "text-muted-foreground")} role={v.warning.severity === "warn" ? "alert" : undefined} data-warning={v.warning.kind}>{v.warning.text}</p>}
      {v.counts && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
          <Count label="Delivered" c={v.counts.delivered} />
          <Count label="Cancelled" c={v.counts.cancelled} />
          <Count label="Returned" c={v.counts.returned} />
          <Count label="Failed delivery" c={v.counts.failed} />
          <Count label="Total parcels" c={v.counts.total} />
          <Count label="Fraud reports listed" c={v.counts.fraudReports} />
          {v.providerRates && (
            <div className="col-span-full"><dt className="text-muted-foreground">Provider-reported rates (not combined)</dt><dd className="font-medium">delivery {v.providerRates.delivery ?? "n/a"}% · cancellation {v.providerRates.cancellation ?? "n/a"}%</dd></div>
          )}
        </dl>
      )}
      {v.checkedAt && <p className="text-[11px] text-muted-foreground" data-checked>Last checked {v.checkedAgo} ({v.checkedUtc}) · <span className="font-medium">{v.source === "cached" ? "Cached" : "Fresh"}</span>: {v.sourceLabel}</p>}
      {v.semantics && <p className="text-[11px] text-muted-foreground">{v.semantics}</p>}
    </>
  );
}

/** Per-courier warnings (unsupported, not configured, unavailable, not checked), most important first. */
export function ProviderWarnings({ view }: { view: HistoryView }) {
  if (view.warnings.length === 0) return null;
  const ordered = [...view.warnings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1));
  return (
    <ul className="space-y-1 text-xs" aria-label="Courier warnings" data-warnings>
      {ordered.map((w) => (
        <li key={w.provider} data-warning-provider={w.provider} className={cn("rounded-lg px-3 py-2", w.severity === "warn" ? "bg-amber-50 text-amber-900" : "bg-secondary/60 text-muted-foreground")}>{w.text}</li>
      ))}
    </ul>
  );
}

/** The combined, verified result plus when it was checked, whether it is saved or fresh, and which couriers could not contribute. */
export function HistoryOverview({ view }: { view: HistoryView }) {
  const c = view.combined;
  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-secondary/40 p-4 text-sm" data-combined data-state={c.state}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Combined verified delivery statistics</p>
      {c.rate !== null ? <p className="font-heading text-3xl">{c.rate}%</p> : <p className="text-sm text-muted-foreground">{c.headline}. A reliable combined delivery rate cannot be calculated.</p>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Count label="Delivered" c={c.delivered} />
        <Count label="Cancelled" c={c.cancelled} />
        <Count label="Returned (not in rate)" c={c.returned} />
        <Count label="Failed (not in rate)" c={c.failed} />
        <Count label="Counted in the rate" c={c.countedInRate} />
        <Count label="Not classified" c={c.notClassified} />
        <Count label="Fraud reports listed" c={c.fraudReports} />
        <div><dt className="text-muted-foreground">Couriers included</dt><dd className="font-medium">{c.couriers.length ? c.couriers.join(", ") : "none"}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground" data-last-checked>
        {view.lastCheckedText ? <>Last checked {view.lastCheckedText} · <span className="font-medium text-foreground">{view.freshnessLabel}</span></> : view.freshnessLabel}
      </p>
      {view.noDataNotice && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900" data-no-data>{view.noDataNotice}</p>}
      {c.excluded.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">{c.excluded.map((e) => <li key={e}>{e}</li>)}</ul>}
      {view.unreported.length > 0 && (
        <div className="text-xs text-muted-foreground" data-unreported>
          <p className="font-medium text-foreground">Not reported by any courier checked (shown as &ldquo;not reported&rdquo;, never as zero):</p>
          <ul className="list-disc space-y-0.5 pl-4">{view.unreported.map((u) => <li key={u.metric}>{u.label}: {u.reasons.join("; ")}.</li>)}</ul>
        </div>
      )}
      {c.notes.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">{c.notes.map((x) => <li key={x}>{x}</li>)}</ul>}
    </div>
  );
}

/** Kept for existing call sites: builds the view from the combined result and the per-courier reports. */
export function CombinedReportView({ combined, reports }: { combined: CombinedReport; reports?: readonly ProviderReport[] }) {
  return <HistoryOverview view={buildHistoryView(reports ?? [], combined)} />;
}

/** Everything for one phone: warnings, the combined result and one card per courier (always all three, in a fixed order). */
export function CourierHistorySection({ reports, combined }: { reports: readonly ProviderReport[]; combined?: CombinedReport }) {
  const view = buildHistoryView(reports, combined ?? combineReports([...reports]));
  return (
    <div className="space-y-3">
      <HistoryOverview view={view} />
      <ProviderWarnings view={view} />
    </div>
  );
}
