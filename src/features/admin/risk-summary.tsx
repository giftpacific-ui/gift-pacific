import { RiskBadge } from "@/features/admin/risk-badge";
import { cn } from "@/lib/utils";
import type { RiskView } from "@/lib/fraud/risk-view";

const utc = (iso: string | null) => (iso ? `${new Date(iso).toISOString().replace("T", " ").slice(0, 16)} UTC` : "not recorded");

/** Customer risk score and the reasons behind it (display only; the decision form stays in the Fraud risk card). Admin pages only. */
export function RiskSummary({ view, orderLabel, compact }: { view: RiskView | null; orderLabel?: string | null; compact?: boolean }) {
  if (!view) return <p className="text-xs text-muted-foreground">Fraud risk scoring is switched off (Fraud settings), so there is no score to show.</p>;
  if (!view.assessed) return <p className="text-xs text-muted-foreground" data-risk-none>{view.courierNote}</p>;
  return (
    <div className="space-y-2 text-xs" data-risk-summary data-level={view.level ?? ""}>
      <p className="flex flex-wrap items-center gap-2">
        <RiskBadge level={view.level} score={view.score} />
        <span className="text-muted-foreground">Score {view.score}/100 · calculated {utc(view.assessedAt)}{orderLabel ? ` · order ${orderLabel}` : ""}{view.mode === "ADVISORY" ? " · advisory mode" : ""}</span>
      </p>
      {view.reasons.length === 0 ? (
        <p>No risk signals were found.</p>
      ) : (
        <ul className="divide-y divide-border/50" aria-label="Risk reasons">
          {(compact ? view.shown : view.reasons).map((r) => (
            <li key={r.code} className="flex items-start justify-between gap-3 py-1.5" data-reason={r.code}>
              <span><span className="font-medium">{r.label}</span><span className="block text-muted-foreground">{r.detail}</span></span>
              <span className={cn("shrink-0 font-medium", r.direction === "lowers" ? "text-emerald-700" : "text-red-700")}>{r.points > 0 ? `+${r.points}` : r.points}</span>
            </li>
          ))}
        </ul>
      )}
      {compact && view.hiddenCount > 0 && <p className="text-muted-foreground">{view.hiddenCount} more reason{view.hiddenCount === 1 ? "" : "s"} in the Fraud risk card.</p>}
      <p className="rounded-lg bg-secondary/50 p-2 text-muted-foreground" data-courier-note>{view.courierNote}</p>
      <p className="text-muted-foreground">{view.disclaimer}</p>
    </div>
  );
}
