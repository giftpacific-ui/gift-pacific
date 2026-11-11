import { isMoneyAmount, toPaisa, fromPaisa } from "@/lib/money";

/**
 * Marketplace / third-party payout rules (pure, unit-tested). One definition used by the order service, the settlement
 * service, the Accounts page, the dashboard, the channel report and every CSV.
 *
 *   expected payout   = order total − verified advance paid directly to us − fees the marketplace WITHHOLDS
 *   fees withheld     = MARKETPLACE_COMMISSION + PAYMENT_FEE cost lines on a MARKETPLACE-channel order
 *                       (the marketplace deducts them before paying, so they are NOT a separate cash outgoing)
 *   received          = sum of payout entries actually recorded (amount, date) — never assumed
 *   receivable        = expected − received (never negative)
 *   state             = PENDING (nothing received) · PARTIAL (some received) · SETTLED (received ≥ expected)
 *
 * Every other cost kind (courier, packaging, other) is paid by us and stays a normal cash outgoing.
 */
export const WITHHELD_COST_KINDS: readonly string[] = ["MARKETPLACE_COMMISSION", "PAYMENT_FEE"];
export type SettlementState = "PENDING" | "PARTIAL" | "SETTLED";

export type PayoutBasis = { total: number; advancePaid: number; costLines: readonly { kind: string; amount: number }[] };

export function feesWithheldPaisa(costLines: PayoutBasis["costLines"]): number {
  return costLines.reduce((s, c) => (WITHHELD_COST_KINDS.includes(c.kind) ? s + toPaisa(c.amount) : s), 0);
}

export function expectedPayoutPaisa(o: PayoutBasis): number {
  const total = toPaisa(o.total);
  const advance = Math.min(toPaisa(o.advancePaid), total);
  return Math.max(total - advance - feesWithheldPaisa(o.costLines), 0);
}

export function settlementState(expectedPaisa: number, receivedPaisa: number): SettlementState {
  if (receivedPaisa <= 0) return expectedPaisa <= 0 ? "SETTLED" : "PENDING";
  return receivedPaisa >= expectedPaisa ? "SETTLED" : "PARTIAL";
}

export type SettlementInput = { orderId: string; amount: number; receivedOn: string; reference?: string | null; idempotencyKey?: string | null; note?: string | null };

/** Normalises a marketplace payout/statement reference so spacing and case cannot hide a duplicate. */
export function normalizeSettlementRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  return v.length === 0 ? null : v;
}

export function validateSettlementInput(raw: Partial<SettlementInput>, now: Date = new Date()): { ok: true; value: Required<Omit<SettlementInput, "reference" | "idempotencyKey" | "note">> & { reference: string | null; idempotencyKey: string | null; note: string | null } } | { ok: false; message: string } {
  if (typeof raw.orderId !== "string" || !raw.orderId) return { ok: false, message: "Choose the order." };
  if (!isMoneyAmount(raw.amount, { min: 0.01, max: 100_000_000 })) return { ok: false, message: "Enter the amount actually received (more than 0, at most 2 decimal places)." };
  const on = raw.receivedOn;
  if (typeof on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(Date.parse(`${on}T00:00:00Z`))) return { ok: false, message: "Enter the date the payout was received." };
  if (new Date(`${on}T00:00:00Z`).toISOString().slice(0, 10) !== on) return { ok: false, message: "Enter a valid payout date." };
  if (Date.parse(`${on}T00:00:00Z`) > now.getTime() + 24 * 3600 * 1000) return { ok: false, message: "The payout date cannot be in the future." };
  if (on < "2000-01-01") return { ok: false, message: "Enter a valid payout date." };
  const reference = normalizeSettlementRef(raw.reference);
  if (reference !== null && (reference.length < 3 || reference.length > 80)) return { ok: false, message: "The payout reference must be 3–80 characters." };
  const key = typeof raw.idempotencyKey === "string" && raw.idempotencyKey.trim() ? raw.idempotencyKey.trim().slice(0, 80) : null;
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, 300) : null;
  return { ok: true, value: { orderId: raw.orderId, amount: raw.amount, receivedOn: on, reference, idempotencyKey: key, note } };
}

export { fromPaisa };
