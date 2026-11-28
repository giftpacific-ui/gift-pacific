import type { RiskLevel } from "@/lib/fraud/policy";

const STYLES: Record<RiskLevel, string> = {
  LOW: "bg-emerald-100 text-emerald-800",
  MEDIUM: "bg-amber-100 text-amber-900",
  HIGH: "bg-orange-100 text-orange-900",
  CRITICAL: "bg-red-100 text-red-900",
};

/** Level pill. Admin-only: risk data is never rendered on a customer page. */
export function RiskBadge({ level, score }: { level: RiskLevel | null; score?: number | null }) {
  if (!level) return <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">not assessed</span>;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[level]}`}>
      {level.toLowerCase()}
      {score != null ? ` · ${score}` : ""}
    </span>
  );
}
