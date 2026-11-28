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

/**
 * The cash a courier booking asks the courier to collect, for comparing with the amount the courier holds. Same rule as checkBookingEligibility():
 * a COD order collects what is unpaid after the verified advance (expectedCod); a self-shipped MARKETPLACE order collects the unpaid total, or 0 when
 * it is already PAID. (expectedCod alone returns 0 for MARKETPLACE, which made every unpaid marketplace booking look like a COD mismatch.)
 */
export function expectedCourierCod(order: { paymentMethod: string; paymentStatus?: string | null; total: unknown; advancePaid: unknown }): number {
  if (order.paymentMethod !== "MARKETPLACE") return expectedCod(order);
  if (order.paymentStatus === "PAID") return 0;
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

// ---------------------------------------------------------------------------
// P5: courier-reported amount, remittance status and discrepancy resolution (all pure)
// ---------------------------------------------------------------------------

/** Flags added in P5 (the five above are unchanged). */
export type CodFlagCodeP5 = CodFlagCode | "BOOKED_AMOUNT_MISMATCH" | "COLLECTION_UNCONFIRMED" | "PARTIAL_DELIVERY";

export const COD_FLAG_LABEL_P5: Record<CodFlagCodeP5, string> = {
  ...COD_FLAG_LABEL,
  BOOKED_AMOUNT_MISMATCH: "Courier recorded a different COD amount",
  COLLECTION_UNCONFIRMED: "Delivered: cash collection not yet confirmed",
  PARTIAL_DELIVERY: "Partially delivered: review items and cash",
};

/** Flags an admin may close with a reason. COLLECTION_UNCONFIRMED is closed by confirming the collection, not by a resolution. */
export const RESOLVABLE_FLAGS: readonly CodFlagCodeP5[] = ["NO_REPORT", "SHORT_COLLECTION", "EXCESS_COLLECTION", "MISSING_SETTLEMENT", "OVER_SETTLED", "BOOKED_AMOUNT_MISMATCH", "PARTIAL_DELIVERY"];

export const COD_RESOLUTION_ACTIONS = ["ACCEPTED_DIFFERENCE", "WRITTEN_OFF"] as const;
export type CodResolutionAction = (typeof COD_RESOLUTION_ACTIONS)[number];
export const COD_RESOLUTION_LABEL: Record<CodResolutionAction, string> = {
  ACCEPTED_DIFFERENCE: "Accept the difference",
  WRITTEN_OFF: "Write off the amount",
};

export type CodFlagP5 = { code: CodFlagCodeP5; amount: number };
export const resolutionKey = (code: string, amount: number) => `${code}:${cents(amount)}`;

/** Splits flags into those still open and those an admin already closed for exactly that flag AND amount (a changed amount re-opens it). */
export function splitFlags(flags: CodFlagP5[], resolutions: { flagCode: string; amount: unknown }[]) {
  const resolved = new Set(resolutions.map((r) => resolutionKey(r.flagCode, Number(r.amount))));
  return {
    open: flags.filter((f) => !resolved.has(resolutionKey(f.code, f.amount))),
    resolved: flags.filter((f) => resolved.has(resolutionKey(f.code, f.amount))),
  };
}

export type RemittanceStatus = "NOT_DUE" | "AWAITING_CONFIRMATION" | "AWAITING_REPORT" | "REPORTED" | "PARTIALLY_SETTLED" | "SETTLED" | "DISCREPANCY" | "RESOLVED";
export const REMITTANCE_LABEL: Record<RemittanceStatus, string> = {
  NOT_DUE: "Nothing due yet",
  AWAITING_CONFIRMATION: "Delivered: collection to be confirmed",
  AWAITING_REPORT: "Awaiting courier's collection report",
  REPORTED: "Collection reported, awaiting settlement",
  PARTIALLY_SETTLED: "Partly settled",
  SETTLED: "Settled",
  DISCREPANCY: "Discrepancy to review",
  RESOLVED: "Discrepancy resolved",
};
/** "COD reconciliation pending" in the admin filters. */
export const PENDING_REMITTANCE: readonly RemittanceStatus[] = ["AWAITING_CONFIRMATION", "AWAITING_REPORT", "REPORTED", "PARTIALLY_SETTLED", "DISCREPANCY"];

const HARD_MISMATCH: readonly CodFlagCodeP5[] = ["SHORT_COLLECTION", "EXCESS_COLLECTION", "OVER_SETTLED", "BOOKED_AMOUNT_MISMATCH", "PARTIAL_DELIVERY"];

export type CodReconcileInput = {
  expected: number;
  /** The ORDER has been delivered (courier-driven or by an admin). Never evidence that cash was received. */
  orderDelivered: boolean;
  /** An explicit COD BALANCE payment record exists: the financial source of truth that the cash was collected. */
  paymentRecorded: boolean;
  /** COD amount the courier holds for the consignment (booking echo / webhook). A consignment figure, not a collection. */
  courierCodAmount: number | null;
  partialDelivery: boolean;
  entries: { kind: string; amount: unknown }[];
  resolutions: { flagCode: string; amount: unknown }[];
};

export function reconcileCod(i: CodReconcileInput) {
  const base = summarizeCod(i.expected, i.orderDelivered, i.entries);
  const all: CodFlagP5[] = [...base.flags];
  if (i.courierCodAmount !== null && cents(i.courierCodAmount) !== cents(i.expected)) {
    all.push({ code: "BOOKED_AMOUNT_MISMATCH", amount: Math.abs(cents(i.courierCodAmount) - cents(i.expected)) / 100 });
  }
  if (i.orderDelivered && i.expected > 0 && !i.paymentRecorded) all.push({ code: "COLLECTION_UNCONFIRMED", amount: i.expected });
  if (i.partialDelivery) all.push({ code: "PARTIAL_DELIVERY", amount: 0 });
  const { open, resolved } = splitFlags(all, i.resolutions);

  const hasReport = i.entries.some((e) => e.kind === "COLLECTION_REPORTED");
  let status: RemittanceStatus;
  if (open.some((f) => HARD_MISMATCH.includes(f.code))) status = "DISCREPANCY";
  else if (open.some((f) => f.code === "COLLECTION_UNCONFIRMED")) status = "AWAITING_CONFIRMATION";
  else if (open.some((f) => f.code === "NO_REPORT")) status = "AWAITING_REPORT";
  else if (!i.orderDelivered && i.entries.length === 0) status = "NOT_DUE";
  else if (i.expected === 0 && i.entries.length === 0) status = "NOT_DUE";
  else if (hasReport && cents(base.outstanding) <= 0) status = resolved.length > 0 ? "RESOLVED" : "SETTLED";
  else if (hasReport && cents(base.settled + base.fees) > 0) status = "PARTIALLY_SETTLED";
  else if (hasReport) status = "REPORTED";
  else status = resolved.length > 0 ? "RESOLVED" : "AWAITING_REPORT";
  return { ...base, flags: open, resolvedFlags: resolved, status };
}

/** A flag the admin may close, with a reason (never silent: the reason is stored and audited by the service). */
export function validateCodResolution(input: { flagCode: unknown; action: unknown; reason: unknown }):
  | { ok: true; flagCode: CodFlagCodeP5; action: CodResolutionAction; reason: string }
  | { ok: false; message: string } {
  if (typeof input.flagCode !== "string" || !(RESOLVABLE_FLAGS as readonly string[]).includes(input.flagCode)) return { ok: false, message: "That discrepancy cannot be resolved this way." };
  if (typeof input.action !== "string" || !(COD_RESOLUTION_ACTIONS as readonly string[]).includes(input.action)) return { ok: false, message: "Choose how the discrepancy is resolved." };
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 10) return { ok: false, message: "Write the reason for this resolution (at least 10 characters)." };
  return { ok: true, flagCode: input.flagCode as CodFlagCodeP5, action: input.action as CodResolutionAction, reason: reason.slice(0, 300) };
}

/**
 * May the admin confirm that the delivered order's cash was collected (which records the COD balance payment)?
 * Refused while a short collection or a partial delivery is still open: recording the full balance would overstate what was received.
 */
export function collectionConfirmable(openFlags: CodFlagP5[]): { ok: true } | { ok: false; message: string } {
  if (openFlags.some((f) => f.code === "SHORT_COLLECTION")) return { ok: false, message: "The courier reported LESS cash than expected. Resolve that shortfall (accept or write it off with a reason) before confirming the collection." };
  if (openFlags.some((f) => f.code === "PARTIAL_DELIVERY")) return { ok: false, message: "The courier reported a partial delivery. Review it and resolve that flag before confirming the collection." };
  return { ok: true };
}

/**
 * A shortfall staff WROTE OFF means that cash was never received, so the order must not be recorded as fully collected (the COD balance payment
 * is always the full balance). An ACCEPTED difference (e.g. an agreed discount) is the admin's explicit statement that the order is settled.
 */
export function writtenOffShortfall(resolvedFlags: CodFlagP5[], resolutions: { flagCode: string; amount: unknown; action: string }[]): boolean {
  return resolvedFlags.some((f) => f.code === "SHORT_COLLECTION" && resolutions.some((r) => r.flagCode === f.code && cents(Number(r.amount)) === cents(f.amount) && r.action === "WRITTEN_OFF"));
}
