/**
 * Courier COD reconciliation rules (pure). The question answered: "the courier was supposed to collect X for this
 * order — what did it report, what did it keep as its fee, and what has it actually paid us?"
 * Nothing here posts revenue: the order already counted the sale, so COD cash is never counted twice.
 */
export const COD_ENTRY_KINDS = ["COLLECTION_REPORTED", "FEE_DEDUCTED", "SETTLEMENT_RECEIVED", "ADJUSTMENT"] as const;
export type CodEntryKind = (typeof COD_ENTRY_KINDS)[number];

export const COD_KIND_LABEL: Record<CodEntryKind, string> = {
  COLLECTION_REPORTED: "Cash collected (reported by courier)",
  FEE_DEDUCTED: "Courier fee deducted",
  SETTLEMENT_RECEIVED: "Settlement received",
  ADJUSTMENT: "Adjustment to collected cash",
};

const cents = (n: number) => Math.round(n * 100);

/** Cash the courier should collect on delivery: what is still unpaid after any verified advance. Non-COD orders: 0. */
export function expectedCod(order: { paymentMethod: string; total: unknown; advancePaid: unknown }): number {
  if (order.paymentMethod !== "COD") return 0;
  return Math.max(0, (cents(Number(order.total)) - cents(Number(order.advancePaid ?? 0))) / 100);
}

export type CodFlagCode = "NO_REPORT" | "SHORT_COLLECTION" | "EXCESS_COLLECTION" | "MISSING_SETTLEMENT" | "OVER_SETTLED";
export const COD_FLAG_LABEL: Record<CodFlagCode, string> = {
  NO_REPORT: "No collection reported",
  SHORT_COLLECTION: "Short collection",
  EXCESS_COLLECTION: "Excess collection",
  MISSING_SETTLEMENT: "Settlement outstanding",
  OVER_SETTLED: "Settled more than collected",
};

export function summarizeCod(expected: number, delivered: boolean, entries: { kind: string; amount: unknown }[]) {
  const sum = (kind: CodEntryKind) => entries.filter((e) => e.kind === kind).reduce((s, e) => s + cents(Number(e.amount)), 0);
  const reported = sum("COLLECTION_REPORTED");
  const adjustments = sum("ADJUSTMENT");
  const fees = sum("FEE_DEDUCTED");
  const settled = sum("SETTLEMENT_RECEIVED");
  const collected = reported + adjustments;
  const outstanding = collected - fees - settled; // what the courier still owes the store
  const expectedC = cents(expected);

  const flags: { code: CodFlagCode; amount: number }[] = [];
  const hasReport = entries.some((e) => e.kind === "COLLECTION_REPORTED");
  if (delivered && expectedC > 0 && !hasReport) flags.push({ code: "NO_REPORT", amount: expectedC / 100 });
  if (hasReport && collected < expectedC) flags.push({ code: "SHORT_COLLECTION", amount: (expectedC - collected) / 100 });
  if (hasReport && collected > expectedC) flags.push({ code: "EXCESS_COLLECTION", amount: (collected - expectedC) / 100 });
  if (collected > 0 && outstanding > 0) flags.push({ code: "MISSING_SETTLEMENT", amount: outstanding / 100 });
  if (outstanding < 0) flags.push({ code: "OVER_SETTLED", amount: -outstanding / 100 });

  return { expected, collected: collected / 100, fees: fees / 100, settled: settled / 100, outstanding: outstanding / 100, flags };
}

export function validateCodEntry(input: { kind: unknown; amount: unknown; reference?: unknown; note?: unknown }):
  | { ok: true; kind: CodEntryKind; amount: number; reference: string | null; note: string | null }
  | { ok: false; message: string } {
  if (typeof input.kind !== "string" || !(COD_ENTRY_KINDS as readonly string[]).includes(input.kind)) return { ok: false, message: "Choose what you are recording." };
  const kind = input.kind as CodEntryKind;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, message: "Enter an amount." };
  if (Math.abs(cents(amount) - amount * 100) > 1e-6) return { ok: false, message: "Use at most two decimal places." };
  if (Math.abs(amount) > 10_000_000) return { ok: false, message: "That amount is too large." };
  if (kind !== "ADJUSTMENT" && amount < 0) return { ok: false, message: "Only an adjustment can be negative." };
  const reference = typeof input.reference === "string" ? input.reference.trim().slice(0, 80) : "";
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
  if (kind === "ADJUSTMENT" && note.length < 5) return { ok: false, message: "An adjustment needs a note explaining why (at least a few words)." };
  return { ok: true, kind, amount: cents(amount) / 100, reference: reference || null, note: note || null };
}
