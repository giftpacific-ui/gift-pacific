import { z } from "zod";
import { paymentStatusFor } from "@/lib/advance-policy";
import { normalizeTxnRef } from "@/lib/payment-reference";
import { expectedPayoutPaisa, normalizeSettlementRef, validateSettlementInput } from "@/lib/settlement";
import { toPaisa } from "@/lib/money";

/**
 * Orders entered by an admin for sales made OUTSIDE the website (Daraz, Cartup, …).
 * Pure validation + totals. These orders never go through checkout: no cart, coupon,
 * payment, notification, analytics event or courier booking is ever triggered by creating one.
 */
export const EXTERNAL_STATUSES = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"] as const;
export const COST_KINDS = ["MARKETPLACE_COMMISSION", "PAYMENT_FEE", "COURIER_FEE", "PACKAGING", "OTHER"] as const;
export type CostKindName = (typeof COST_KINDS)[number];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** `d-123`, ` D-123 ` and `D–123` must all be the SAME reference for duplicate detection. */
export function normalizeExternalRef(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Enter the marketplace order number." };
  const value = raw.normalize("NFKC").replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, "").toUpperCase();
  if (value.length < 3 || value.length > 80) return { ok: false, message: "The marketplace order number must be 3–80 characters." };
  if (!/^[A-Z0-9._\-/#]+$/.test(value)) return { ok: false, message: "The marketplace order number may only contain letters, numbers and . _ - / #" };
  return { ok: true, value };
}

const money = (label: string, max = 10_000_000) =>
  z.number({ message: `${label} must be a number` }).finite().min(0, `${label} cannot be negative`).max(max, `${label} is too large`)
    .refine((n) => round2(n) === n, `${label} can have at most 2 decimal places`);

const itemSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1).nullable().optional(),
  quantity: z.number().int("Quantity must be a whole number").min(1).max(9999),
  // The price the customer ACTUALLY paid on the marketplace (not necessarily our list price).
  unitPrice: money("Unit price"),
  // Cost of one unit if the admin knows it; otherwise unknown (never guessed).
  unitCost: money("Unit cost").nullable().optional(),
  // Customizable combos only: the admin's picks. Validated by resolveCombo() (never trusted here).
  selections: z.array(z.object({ slotId: z.string().min(1), optionId: z.string().min(1), quantity: z.number().int().min(1).max(99) })).max(50).optional(),
});

export const externalOrderSchema = z.object({
  channelId: z.string().min(1, "Choose a sales channel"),
  externalOrderRef: z.string(),
  externalPlacedAt: z.string().optional().nullable(),
  customer: z.object({
    fullName: z.string().trim().min(1, "Customer name is required").max(100),
    phone: z.string().transform((v) => v.replace(/[\s()-]/g, "")).refine((v) => /^\+?[0-9]{6,15}$/.test(v), "Enter a valid phone number"),
    email: z.string().trim().toLowerCase().email("Enter a valid email").max(200).optional().or(z.literal("")),
    line1: z.string().trim().min(1, "Address is required").max(300),
    city: z.string().trim().max(80).optional(),
  }),
  items: z.array(itemSchema).min(1, "Add at least one item").max(50),
  shippingTotal: money("Shipping").default(0),
  discountTotal: money("Discount").default(0),
  status: z.enum(EXTERNAL_STATUSES).default("CONFIRMED"),
  paymentStatus: z.enum(["PAID", "UNPAID"]).default("PAID"),
  fulfillmentMode: z.enum(["SELF_SHIP", "MARKETPLACE_FULFILLED"]).default("SELF_SHIP"),
  // DEDUCT: take stock now (default). NONE: stock was already adjusted / marketplace holds it.
  stockPolicy: z.enum(["DEDUCT", "NONE"]).default("DEDUCT"),
  // Money the customer ALREADY paid directly to us (e.g. a Facebook order with a bKash advance). Never includes marketplace payouts.
  advanceReceived: money("Advance received").default(0),
  advanceMethod: z.enum(["BKASH", "NAGAD", "COD"]).default("COD"), // COD = cash/other, recorded by staff
  advanceReference: z.string().trim().max(60).optional().or(z.literal("")),
  // Marketplace payout ACTUALLY RECEIVED so far (0 = nothing yet). Never assumed: the amount and date are entered. Marketplace channels only.
  settlementReceived: money("Payout received").default(0),
  settlementReceivedOn: z.string().optional().nullable(),
  settlementReference: z.string().trim().max(80).optional().or(z.literal("")),
  // DEPRECATED: a bare "settled" flag used to mean "the full total arrived". It is still accepted only so old clients get a clear error.
  settlementStatus: z.enum(["PENDING", "SETTLED"]).optional(),
  note: z.string().trim().max(1000).optional(),
  costLines: z.array(z.object({ kind: z.enum(COST_KINDS), amount: money("Cost"), note: z.string().trim().max(200).optional() })).max(10).default([]),
});

export type ExternalOrderInput = Omit<z.output<typeof externalOrderSchema>, "advanceReference" | "settlementReference"> & {
  externalOrderRef: string;
  /** Normalised wallet transaction id (upper-case, no spaces/dashes) or "" when none. */
  advanceReference: string;
  /** Normalised payout reference or null. */
  settlementReference: string | null;
};

export function parseExternalOrderInput(raw: unknown): { ok: true; value: ExternalOrderInput } | { ok: false; message: string } {
  const parsed = externalOrderSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Please check the form." };
  const ref = normalizeExternalRef(parsed.data.externalOrderRef);
  if (!ref.ok) return ref;
  let placed: string | null = null;
  if (parsed.data.externalPlacedAt) {
    const d = new Date(parsed.data.externalPlacedAt);
    if (Number.isNaN(d.getTime())) return { ok: false, message: "Enter a valid order date." };
    if (d.getTime() > Date.now() + 24 * 3600 * 1000) return { ok: false, message: "The order date cannot be in the future." };
    placed = d.toISOString();
  }
  const totals = computeExternalTotals(parsed.data.items, parsed.data.shippingTotal, parsed.data.discountTotal);
  if (parsed.data.discountTotal > totals.subtotal) return { ok: false, message: "The discount cannot be larger than the items subtotal." };
  if (round2(totals.total) < parsed.data.advanceReceived) return { ok: false, message: "The advance cannot be larger than the order total." };
  // Wallet advances need a transaction id; it is normalised so `8n7a 6d5ee7` and `8N7A6D5EE7` are the SAME transaction (duplicate guard).
  const rawAdvanceRef = (parsed.data.advanceReference ?? "").trim();
  let advanceReference = "";
  if (parsed.data.advanceReceived > 0 && parsed.data.advanceMethod !== "COD") {
    const t = normalizeTxnRef(rawAdvanceRef);
    if (!t.ok) return { ok: false, message: rawAdvanceRef ? t.message : "Enter the wallet transaction id for the advance." };
    advanceReference = t.value;
  } else if (parsed.data.advanceReceived > 0 && rawAdvanceRef) {
    const t = normalizeTxnRef(rawAdvanceRef);
    if (!t.ok) return { ok: false, message: t.message };
    advanceReference = t.value;
  } else if (parsed.data.advanceReceived <= 0 && rawAdvanceRef) {
    return { ok: false, message: "A transaction id was entered but the advance amount is 0. Enter the amount received or clear the transaction id." };
  }

  // Marketplace payout: never assumed. A bare "settled" flag is refused; an amount needs a date; it can never exceed what is expected.
  const received = parsed.data.settlementReceived;
  if (parsed.data.settlementStatus === "SETTLED" && received <= 0) return { ok: false, message: "Enter the payout amount that actually arrived and the date. An order can no longer be marked settled without an amount." };
  let settlementReference: string | null = null;
  if (received > 0) {
    const check = validateSettlementInput({ orderId: "new", amount: received, receivedOn: parsed.data.settlementReceivedOn ?? "", reference: parsed.data.settlementReference });
    if (!check.ok) return { ok: false, message: check.message };
    settlementReference = check.value.reference;
    const expected = expectedPayoutPaisa({ total: totals.total, advancePaid: parsed.data.advanceReceived, costLines: parsed.data.costLines });
    if (toPaisa(received) > expected) return { ok: false, message: `The payout received (${received}) is more than the expected payout (${expected / 100} = total − advance − commission/fees). Correct the commission if the marketplace deducted more.` };
  } else if (parsed.data.settlementReference) {
    settlementReference = normalizeSettlementRef(parsed.data.settlementReference);
  }
  return { ok: true, value: { ...parsed.data, advanceReference, settlementReference, externalOrderRef: ref.value, externalPlacedAt: placed } };
}

export function computeExternalTotals(items: readonly { unitPrice: number; quantity: number }[], shippingTotal: number, discountTotal: number) {
  const subtotal = round2(items.reduce((sum, i) => sum + round2(i.unitPrice * i.quantity), 0));
  const total = round2(Math.max(subtotal - discountTotal + shippingTotal, 0));
  return { subtotal, total };
}

/**
 * Order-level payment LABEL for an entered third-party order. It is a label only (cash is derived from verified payment rows and recorded
 * payouts, never from this), but it must not lie: a VERIFIED advance decides it, so a partial advance is PARTIALLY_PAID — never PAID.
 * With no advance, only a marketplace order may be PAID (the customer paid the marketplace); any other channel stays UNPAID until money is verified.
 */
export function externalPaymentStatus(channelKind: "WEBSITE" | "MARKETPLACE" | "OTHER", total: number, advanceReceived: number, entered: "PAID" | "UNPAID"): "UNPAID" | "PARTIALLY_PAID" | "PAID" {
  if (advanceReceived > 0) return paymentStatusFor(total, advanceReceived);
  return channelKind === "MARKETPLACE" ? entered : "UNPAID";
}
