import { LEVEL_RANK, type RiskLevel } from "@/lib/fraud/policy";

/**
 * The customer risk score and its reasons, shaped for display (pure; client-safe). It READS an already-calculated assessment (the P4 score, as stored
 * with the order): nothing is recomputed here and nothing is decided. Reasons that raise the score come first, strongest first, then the credits.
 */
export type RiskSignalInput = { code: string; label: string; points: number; detail: string; refs?: string[] };
export type RiskPanelInput = {
  mode: "OFF" | "ADVISORY" | "ENFORCE";
  assessed: boolean;
  score: number | null;
  level: RiskLevel | null;
  assessedAt: Date | string | null;
  signals: readonly RiskSignalInput[];
};

export type RiskReasonView = { code: string; label: string; detail: string; points: number; direction: "raises" | "lowers"; refs: string[] };
export type RiskView = {
  /** false = no stored assessment (OFF, or the order has not been assessed yet). */
  assessed: boolean;
  mode: RiskPanelInput["mode"];
  score: number | null;
  level: RiskLevel | null;
  levelLabel: string;
  assessedAt: string | null;
  reasons: RiskReasonView[];
  /** The first few reasons, for compact screens; `hiddenCount` says how many more exist. */
  shown: RiskReasonView[];
  hiddenCount: number;
  /** Says whether, and how, courier delivery history is part of this score. Never claims more than the stored signals show. */
  courierNote: string;
  /** What the score is and is not: evidence for staff, not a verdict. */
  disclaimer: string;
};

export const LEVEL_LABEL: Record<RiskLevel, string> = { LOW: "Low risk", MEDIUM: "Medium risk", HIGH: "High risk", CRITICAL: "Critical risk" };
export const COURIER_SIGNAL_CODE = "LOW_TRUST_EVIDENCE";

/** `courierContributed`: how many couriers gave a usable answer for this phone (null = unknown). */
export function buildRiskView(panel: RiskPanelInput | null, courierContributed: number | null, opts: { maxShown?: number } = {}): RiskView {
  const maxShown = opts.maxShown ?? 6;
  const p = panel;
  // Reasons belong to a score: with no assessment there is nothing to explain, whatever signals a caller passes.
  const reasons: RiskReasonView[] = (p?.assessed ? p.signals : [])
    .filter((s) => s.points !== 0)
    .map((s) => ({ code: s.code, label: s.label, detail: s.detail, points: s.points, direction: (s.points > 0 ? "raises" : "lowers") as "raises" | "lowers", refs: s.refs ?? [] }))
    .sort((a, b) => (a.direction === b.direction ? Math.abs(b.points) - Math.abs(a.points) || a.code.localeCompare(b.code) : a.direction === "raises" ? -1 : 1));
  const courierSignal = reasons.find((r) => r.code === COURIER_SIGNAL_CODE);
  const courierNote = !p?.assessed
    ? "No risk score has been calculated for this order yet."
    : courierSignal
      ? `Courier delivery history raised this score by ${courierSignal.points}: the combined delivery rate was low with enough parcels to rely on.`
      : courierContributed === 0
        ? "No courier history was available, so it is not counted in this score. An unavailable or unsupported courier never raises the score and never rejects an order."
        : "Courier delivery history did not raise this score.";
  return {
    assessed: !!p?.assessed && p.score !== null && p.level !== null,
    mode: p?.mode ?? "OFF",
    score: p?.score ?? null,
    level: p?.level ?? null,
    levelLabel: p?.level ? LEVEL_LABEL[p.level] : "Not assessed",
    assessedAt: p?.assessedAt ? new Date(p.assessedAt).toISOString() : null,
    reasons, shown: reasons.slice(0, maxShown), hiddenCount: Math.max(0, reasons.length - maxShown),
    courierNote,
    disclaimer: "The score is evidence for a staff decision, not a verdict. A missing or unavailable courier answer is never counted against the customer.",
  };
}

/** The highest level among several views (used to headline a phone that has several assessed orders). */
export const highestLevel = (levels: (RiskLevel | null)[]): RiskLevel | null =>
  levels.reduce<RiskLevel | null>((best, l) => (l && (!best || LEVEL_RANK[l] > LEVEL_RANK[best]) ? l : best), null);
