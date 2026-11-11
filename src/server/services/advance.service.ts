import "server-only";
import { notifyUser } from "@/server/services/notification.service";
import type { DeliveryZone, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import {
  trustFromOutcome,
  normalizeBdPhone,
  tierForScore,
  totalParcels,
  decideAdvance,
  derivePayment,
  policyZoneFor,
  sanitizePolicy,
  validateAdvancePolicy,
  type AdvanceDecision,
  type AdvancePolicy,
  type TrustResult,
} from "@/lib/advance-policy";
import { normalizeTxnRef } from "@/lib/payment-reference";
import { fraudSource, isPhoneVerified, lookupFraudCheck, type FraudLookup } from "@/server/services/fraud-check.service";

type Db = Pick<Prisma.TransactionClient, "order" | "storeSettings">;
type Tx = Prisma.TransactionClient;
const ZONES: DeliveryZone[] = ["DHAKA_CITY", "OUTSIDE_DHAKA", "OTHER"];

export type AdvanceSettings = AdvancePolicy & {
  instructions: string | null;
  zones: DeliveryZone[];
  reviewEnabled: boolean;
};

/**
 * The policy in force. Stored values that fail validation never weaken the policy silently: the built-in defaults (200 / 100, 60 / 80 / 100,
 * zero advance off, review on) are used instead and `problem` carries the reason for the admin screen.
 */
export async function getAdvanceSettings(
  db: Pick<Prisma.TransactionClient, "storeSettings"> = prisma,
): Promise<AdvanceSettings & { problem: string | null }> {
  const s = await db.storeSettings.findUnique({ where: { id: "singleton" } });
  const raw: AdvanceSettings = {
    enabled: s?.advanceEnabled ?? false,
    zones: (s?.advanceZones as DeliveryZone[] | undefined) ?? ["OUTSIDE_DHAKA"],
    standardAmount: Number(s?.advanceStandardAmount ?? 200),
    reducedAmount: Number(s?.advanceReducedAmount ?? 100),
    zeroAtFullTrust: s?.advanceZeroAtFullTrust ?? false,
    lowBelow: s?.trustLowBelow ?? 60,
    reducedFrom: s?.trustReducedFrom ?? 80,
    fullAt: s?.trustFullAt ?? 100,
    reviewEnabled: s?.trustReviewEnabled ?? true,
    instructions: s?.advanceInstructions ?? null,
  };
  const { policy, problem } = sanitizePolicy(raw);
  return { ...raw, ...policy, zones: policy.zones as DeliveryZone[], reviewEnabled: policy.reviewEnabled !== false, problem };
}

/** Defence in depth: service functions that change money state re-check that the actor is an ACTIVE ADMIN, whoever called them. */
/**
 * Who is performing a sensitive service operation. Either a named ADMIN (re-checked in the database: exists, active, role ADMIN) or one of a
 * few INTERNAL system flows that no customer input can reach (a signed courier webhook, the secret-protected reconcile job). There is no
 * "anonymous" and no default: a caller that does not say who it is is refused.
 */
export const SYSTEM_ACTORS = ["courier-sync", "courier-reconcile"] as const;
export type ServiceActor = { adminId: string | null | undefined } | { system: (typeof SYSTEM_ACTORS)[number] };

/** Authorises a ServiceActor inside a service operation. Admins are re-read from the database; system actors must be a known internal flow. */
export async function assertServiceActor(db: Pick<Tx, "user">, actor: ServiceActor | null | undefined): Promise<void> {
  if (actor && typeof actor === "object" && "system" in actor) {
    if ((SYSTEM_ACTORS as readonly string[]).includes(actor.system)) return;
    throw new UserFacingError("You are not authorised to do this.");
  }
  await assertAdminActor(db, actor && typeof actor === "object" && "adminId" in actor ? actor.adminId : null);
}

export async function assertAdminActor(db: Pick<Tx, "user">, actorId: string | null | undefined): Promise<string> {
  if (!actorId) throw new UserFacingError("You are not authorised to do this.");
  const u = await db.user.findUnique({ where: { id: actorId }, select: { role: true, isActive: true } });
  if (!u || !u.isActive || u.role !== "ADMIN") throw new UserFacingError("You are not authorised to do this.");
  return actorId;
}

export async function recordAudit(
  db: Pick<Tx, "adminAuditEvent">,
  e: { actorId: string | null; action: string; entityType: string; entityId?: string | null; detail?: Record<string, unknown> },
) {
  await db.adminAuditEvent.create({ data: { actorId: e.actorId, action: e.action, entityType: e.entityType, entityId: e.entityId ?? null, detail: (e.detail ?? {}) as Prisma.InputJsonValue } });
}

/** Saves the advance policy (validated), records who changed it and the before/after values. Orders already placed keep their own snapshot. */
export async function saveAdvanceSettings(input: AdvanceSettings, actorId: string | null) {
  const zones = input.zones.filter((z): z is DeliveryZone => ZONES.includes(z as DeliveryZone));
  const error = validateAdvancePolicy({ ...input, zones });
  if (error) throw new UserFacingError(error);
  if (input.instructions && input.instructions.length > 1000) throw new UserFacingError("Payment instructions are too long (max 1000 characters).");

  const data = {
    advanceEnabled: input.enabled,
    advanceZones: zones as DeliveryZone[],
    advanceStandardAmount: input.standardAmount,
    advanceReducedAmount: input.reducedAmount,
    advanceZeroAtFullTrust: input.zeroAtFullTrust,
    trustLowBelow: input.lowBelow,
    trustReducedFrom: input.reducedFrom,
    trustFullAt: input.fullAt,
    trustReviewEnabled: input.reviewEnabled !== false,
    advanceInstructions: input.instructions?.trim() || null,
    advancePolicyUpdatedAt: new Date(),
    advancePolicyUpdatedById: actorId,
  };
  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, actorId);
    const before = await getAdvanceSettings(tx);
    await tx.storeSettings.upsert({ where: { id: "singleton" }, update: data, create: { id: "singleton", ...data } });
    const pick = (x: AdvanceSettings) => ({ enabled: x.enabled, zones: x.zones, standard: x.standardAmount, reduced: x.reducedAmount, zeroAtFullTrust: x.zeroAtFullTrust, lowBelow: x.lowBelow, reducedFrom: x.reducedFrom, fullAt: x.fullAt, reviewEnabled: x.reviewEnabled });
    await recordAudit(tx, { actorId, action: "ADVANCE_POLICY_CHANGED", entityType: "ADVANCE_POLICY", entityId: "singleton", detail: { before: pick(before), after: pick({ ...input, zones }) } });
  });
}

/**
 * What the fraud check said, in the form stored on the order (`trustSnapshot.fraudCheck`) and shown to admins. Holds NO phone number, only its last
 * four digits so an admin can notice that the phone on the order was edited after the check. Never sent to customers.
 */
export type FraudEvidence = {
  status: "ok" | "no_history" | "unavailable";
  reason: string | null;
  provider: string | null;
  delivered: number | null;
  cancelled: number | null;
  returned: number | null;
  total: number | null;
  /** `provider` = a real provider answered; `fallback` = the safe default policy was used (no check really happened). */
  source: "provider" | "fallback";
  checkedAt: string;
  cached: boolean;
  phoneVerified: boolean;
  phoneLast4: string | null;
};

export function fraudEvidence(outcome: FraudLookup, phoneVerified: boolean, rawPhone: string | null | undefined): FraudEvidence {
  const ok = outcome.status === "ok" ? outcome.history : null;
  const phone = normalizeBdPhone(rawPhone);
  return {
    status: outcome.status,
    reason: outcome.status === "unavailable" ? outcome.reason : null,
    provider: outcome.status === "unavailable" ? null : outcome.provider,
    delivered: ok ? ok.delivered : null,
    cancelled: ok ? ok.cancelled : null,
    returned: ok ? (ok.returned ?? null) : null,
    total: ok ? totalParcels(ok) : null,
    source: fraudSource(outcome),
    checkedAt: outcome.checkedAt,
    cached: outcome.cached,
    phoneVerified,
    phoneLast4: phone ? phone.slice(-4) : null,
  };
}

export type AdvanceQuote = {
  decision: AdvanceDecision;
  trust: TrustResult;
  /** What the fraud check answered; frozen on the order for admins. Never sent to customers. */
  fraud: { outcome: FraudLookup; phoneVerified: boolean };
  settings: AdvanceSettings;
  /** The zone the customer claimed, and the zone the POLICY used (stricter when the address contradicts the claim). */
  claimedZone: DeliveryZone;
  policyZone: string;
  zoneConflict: boolean;
  /** Stored settings were invalid and the built-in defaults were used (shown to admins). */
  settingsProblem: string | null;
};

/**
 * The ONLY place an advance requirement is decided. The browser never supplies a score or an amount: it supplies a zone claim and an address,
 * which can only make the decision STRICTER (see policyZoneFor), never looser.
 */
export async function quoteAdvance(
  db: Db,
  args: { phone?: string | null; zone: DeliveryZone; orderTotal: number; address?: { city?: string | null; state?: string | null; line1?: string | null; line2?: string | null } },
): Promise<AdvanceQuote> {
  const { problem, ...settings } = await getAdvanceSettings(db);
  // Evidence = fraud-check record for the order's phone ONLY (our own order history is not used). Any failure => default 50, never an error.
  const phoneVerified = isPhoneVerified();
  const outcome = await lookupFraudCheck(args.phone);
  const trust = trustFromOutcome(outcome, { phoneVerified });
  const z = args.address ? policyZoneFor(args.zone, args.address) : { zone: args.zone as string, conflict: false };
  const decision = decideAdvance(settings, { zone: z.zone, orderTotal: args.orderTotal, trustScore: trust.score, zoneConflict: z.conflict });
  return { decision, trust, fraud: { outcome, phoneVerified }, settings, claimedZone: args.zone, policyZone: z.zone, zoneConflict: z.conflict, settingsProblem: problem };
}

// ---------------------------------------------------------------------------------------------
// Admin: verify / reject an advance, or waive it with a recorded reason.
// ---------------------------------------------------------------------------------------------

/**
 * Admin confirms that money really arrived (e.g. checked in the merchant wallet statement). Only then does the advance count.
 * `providerRef` is the wallet's transaction id AS CONFIRMED BY THE ADMIN; (method, providerRef) is UNIQUE (normalised, case-insensitive), so one
 * transaction can never be counted twice, on this or any other order. The row is claimed with a conditional update, so double-clicks/retries
 * are harmless. The actor is re-checked as an active ADMIN here (not only in the server action) and the verification is written to the audit trail.
 */
export async function verifyAdvancePayment(args: {
  paymentId: string;
  adminId: string;
  providerRef: string;
  amount: number;
}) {
  // Normalised (upper-case, no spaces/dashes) so the same wallet transaction typed two ways is still ONE transaction.
  const normalized = normalizeTxnRef(args.providerRef);
  if (!normalized.ok) throw new UserFacingError(normalized.message);
  const ref = normalized.value;
  if (!Number.isFinite(args.amount) || args.amount <= 0)
    throw new UserFacingError("Enter the amount that was actually received.");
  const amount = Math.round(args.amount * 100) / 100;

  try {
    return await prisma.$transaction(async (tx) => {
      await assertAdminActor(tx, args.adminId);
      const pay = await tx.payment.findUnique({ where: { id: args.paymentId } });
      if (!pay || pay.kind !== "ADVANCE") throw new UserFacingError("Advance payment not found.");
      const dup = await tx.payment.findFirst({
        where: { method: pay.method, providerRef: { equals: ref, mode: "insensitive" }, id: { not: pay.id } },
        select: { id: true },
      });
      if (dup) throw new UserFacingError("That transaction id has already been used for another payment.");
      const claimed = await tx.payment.updateMany({
        where: { id: pay.id, status: "PENDING" },
        data: { status: "PAID", providerRef: ref, amount, verifiedById: args.adminId, verifiedAt: new Date() },
      });
      if (claimed.count !== 1) throw new UserFacingError("This advance was already verified or rejected.");
      const order = await tx.order.findUniqueOrThrow({ where: { id: pay.orderId }, select: { id: true, total: true, advancePaid: true, status: true, userId: true, orderNumber: true } });
      const paid = Math.round((Number(order.advancePaid) + amount) * 100) / 100;
      // Never clamp silently: that would leave the Payment row and Order.advancePaid disagreeing about how much real money arrived.
      if (Math.round(paid * 100) > Math.round(Number(order.total) * 100))
        throw new UserFacingError(`Verified advances would total ${paid}, more than this order's total of ${Number(order.total)}. Enter only the amount that belongs to this order.`);
      await tx.order.update({ where: { id: order.id }, data: { advancePaid: paid } });
      await syncOrderPayment(tx, order.id);
      await tx.orderTrackingEvent.create({ data: { orderId: order.id, status: order.status, note: `Advance of ${amount} verified (${pay.method}).` } });
      await notifyUser(tx, {
        userId: order.userId,
        type: "PAYMENT",
        title: "Payment verified",
        body: `We received your advance payment for order ${order.orderNumber}.`,
        href: `/account/orders/${order.orderNumber}`,
        dedupeKey: `payment:${pay.id}:verified`,
      });
      await recordAudit(tx, { actorId: args.adminId, action: "ADVANCE_VERIFIED", entityType: "ORDER", entityId: order.id, detail: { paymentId: pay.id, method: pay.method, providerRef: ref, claimedReference: pay.customerReference, amount, advancePaidAfter: paid } });
      return { orderId: order.id, advancePaid: paid };
    });
  } catch (error) {
    // Two admins verifying the same wallet transaction on two orders at once: the (method, providerRef) unique index lets one through.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002")
      throw new UserFacingError("That transaction id has already been used for another payment.");
    throw error;
  }
}

export async function rejectAdvancePayment(args: { paymentId: string; adminId: string; reason: string }) {
  const reason = args.reason.trim();
  if (!reason) throw new UserFacingError("Give a reason for rejecting the payment.");
  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, args.adminId);
    const pay = await tx.payment.findUnique({ where: { id: args.paymentId }, select: { orderId: true, kind: true, customerReference: true, order: { select: { userId: true, orderNumber: true } } } });
    const res = await tx.payment.updateMany({
      where: { id: args.paymentId, kind: "ADVANCE", status: "PENDING" },
      data: { status: "FAILED", verifiedById: args.adminId, verifiedAt: new Date(), rawResponse: { rejectedReason: reason.slice(0, 300) } },
    });
    if (res.count !== 1) throw new UserFacingError("This advance was already verified or rejected.");
    if (pay?.order) {
      // The customer is told the claim was not accepted (never the internal reason text), so they can submit the correct reference.
      await notifyUser(tx, {
        userId: pay.order.userId,
        type: "PAYMENT",
        title: "Payment could not be verified",
        body: `We could not verify the payment reference for order ${pay.order.orderNumber}. Please check it and submit it again.`,
        href: `/account/orders/${pay.order.orderNumber}`,
        dedupeKey: `payment:${args.paymentId}:rejected`,
      });
    }
    await recordAudit(tx, { actorId: args.adminId, action: "ADVANCE_REJECTED", entityType: "ORDER", entityId: pay?.orderId ?? null, detail: { paymentId: args.paymentId, claimedReference: pay?.customerReference ?? null, reason: reason.slice(0, 300) } });
  });
}

/**
 * Authorised staff may waive a required advance. A reason (min 5 characters) is mandatory; who, when and why are stored on the order AND in the
 * audit trail. A waiver is a DECISION, not money: it never changes `advancePaid` or the payment status, and it does not count against the
 * customer's trust history. Only possible once, while the order is PENDING and an advance is actually still outstanding.
 */
export async function waiveAdvance(args: { orderId: string; adminId: string; reason: string }) {
  const reason = args.reason.trim();
  if (reason.length < 5) throw new UserFacingError("Give a reason (at least a few words) for waiving the advance.");
  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, args.adminId);
    const o = await tx.order.findUnique({ where: { id: args.orderId }, select: { advanceRequired: true, advancePaid: true } });
    if (!o) throw new UserFacingError("Order not found.");
    if (Number(o.advanceRequired) <= Number(o.advancePaid)) throw new UserFacingError("There is no outstanding advance to waive on this order.");
    const res = await tx.order.updateMany({
      where: { id: args.orderId, advanceWaivedById: null, status: "PENDING" },
      data: { advanceWaivedById: args.adminId, advanceWaivedReason: reason.slice(0, 300), advanceWaivedAt: new Date() },
    });
    if (res.count !== 1) throw new UserFacingError("The advance can only be waived once, while the order is still pending.");
    await recordAudit(tx, { actorId: args.adminId, action: "ADVANCE_WAIVED", entityType: "ORDER", entityId: args.orderId, detail: { reason: reason.slice(0, 300), advanceRequired: Number(o.advanceRequired), advancePaid: Number(o.advancePaid) } });
  });
}

/**
 * Records that a staff member reviewed a low-trust order (the decision to require the review was made and stored at checkout).
 * Required before the order can be confirmed, shipped or booked with a courier. Idempotent: a second review is refused, not duplicated.
 */
export async function reviewTrustOrder(args: { orderId: string; adminId: string; note: string }) {
  const note = args.note.trim();
  if (note.length < 3) throw new UserFacingError("Write what you checked (e.g. called the customer, confirmed the address).");
  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, args.adminId);
    const res = await tx.order.updateMany({
      where: { id: args.orderId, trustReviewRequired: true, trustReviewedAt: null, status: { in: ["PENDING", "CONFIRMED", "PROCESSING"] } },
      data: { trustReviewedById: args.adminId, trustReviewedAt: new Date(), trustReviewNote: note.slice(0, 300) },
    });
    if (res.count !== 1) throw new UserFacingError("This order does not need a review, was already reviewed, or has already left the warehouse.");
    await recordAudit(tx, { actorId: args.adminId, action: "TRUST_REVIEWED", entityType: "ORDER", entityId: args.orderId, detail: { note: note.slice(0, 300) } });
  });
}

type GateOrder = { advanceRequired: unknown; advancePaid: unknown; advanceWaivedById: string | null; trustReviewRequired: boolean; trustReviewedAt: Date | null };

/** Why this order may not be confirmed/dispatched yet (null = ready). The ONLY definition of the gate; used by the status funnel and courier booking. */
export function dispatchBlockedReason(o: GateOrder): string | null {
  if (advanceOutstanding(o)) return "This order is waiting for its advance payment to be verified (or waived with a reason) before it can be confirmed or dispatched.";
  if (o.trustReviewRequired && !o.trustReviewedAt) return "This order needs a staff review (low trust score or delivery-zone mismatch) before it can be confirmed or dispatched.";
  return null;
}

export async function assertDispatchReady(db: Pick<Tx, "order">, orderId: string): Promise<void> {
  const o = await db.order.findUnique({
    where: { id: orderId },
    select: { advanceRequired: true, advancePaid: true, advanceWaivedById: true, trustReviewRequired: true, trustReviewedAt: true },
  });
  if (!o) throw new UserFacingError("Order not found.");
  const reason = dispatchBlockedReason(o);
  if (reason) throw new UserFacingError(reason);
}

/**
 * Re-derives paymentStatus (and the cached advancePaid) from the RECORDS: verified Payment rows and recorded refunds — never from a claim, never
 * from a hand-set label. A partial payment can never yield PAID. Recorded money is never reduced automatically: if the cached column and the verified
 * rows disagree the larger figure stands (a column above the rows is legacy history) and `drift: true` is returned for an admin to look at.
 */
export async function syncOrderPayment(tx: Pick<Tx, "order" | "payment" | "financialIncident">, orderId: string): Promise<{ drift: boolean; paid: number; status: string }> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true, advanceRequired: true, advancePaid: true, advanceWaivedById: true, paymentStatus: true } });
  const pays = await tx.payment.findMany({ where: { orderId, kind: "ADVANCE" }, select: { status: true, amount: true } });
  const bal = await tx.payment.findMany({ where: { orderId, kind: "BALANCE" }, select: { status: true, amount: true } });
  const refunds = await tx.financialIncident.findMany({ where: { orderId }, select: { refundAmount: true } });
  const refunded = refunds.reduce((a, r) => a + Math.round(Number(r.refundAmount) * 100), 0) / 100;
  const rows = pays.filter((x) => x.status === "PAID").reduce((a, x) => a + Math.round(Number(x.amount) * 100), 0) / 100;
  const column = Number(o.advancePaid);
  const drift = Math.round(column * 100) !== Math.round(rows * 100);
  // Money already on file is NEVER reduced automatically (a column > rows means legacy/hand history we cannot re-derive): the larger figure is used
  // and the disagreement is reported. A column < rows (a verified row the cache missed) is corrected upwards.
  const advance = Math.max(rows, column);
  // COD collected on delivery is recorded as an explicit BALANCE payment (see recordCodCollection). It counts toward the payment STATUS but never
  // toward `advancePaid`, which stays "advances only" so the accounting (advance cash + COD on delivery) cannot count the same money twice.
  const balance = bal.filter((x) => x.status === "PAID").reduce((a, x) => a + Math.round(Number(x.amount) * 100), 0) / 100;
  const payments = [
    ...pays.map((x) => ({ status: x.status, amount: Number(x.amount) })),
    ...(advance > rows ? [{ status: "PAID", amount: Math.round((advance - rows) * 100) / 100 }] : []),
    ...(balance > 0 ? [{ status: "PAID", amount: balance }] : []),
  ];
  const d = derivePayment({ total: Number(o.total), advanceRequired: Number(o.advanceRequired), waived: Boolean(o.advanceWaivedById), payments, refunded });
  await tx.order.update({ where: { id: orderId }, data: { advancePaid: advance, paymentStatus: d.status } });
  return { drift, paid: d.paid, status: d.status };
}

/**
 * Records that the cash-on-delivery balance was collected, at the moment staff mark a (non-marketplace) order DELIVERED: one explicit BALANCE
 * payment for `total − verified advance`, written once. This is the same event the accounting counts as "COD collected", now visible as a record, so
 * the payment status of a delivered order is derived (PAID) instead of being typed in. Marketplace orders are paid out by the marketplace and are
 * handled by settlements. Courier remittance is not modelled (documented limit).
 */
export async function recordCodCollection(tx: Pick<Tx, "order" | "payment" | "financialIncident">, orderId: string): Promise<void> {
  const o = await tx.order.findUnique({ where: { id: orderId }, select: { total: true, advancePaid: true, currency: true, channel: { select: { kind: true } } } });
  if (!o || o.channel?.kind === "MARKETPLACE") return;
  const balance = Math.round((Number(o.total) - Number(o.advancePaid)) * 100) / 100;
  const already = await tx.payment.findFirst({ where: { orderId, kind: "BALANCE" }, select: { id: true } });
  if (balance > 0 && !already) {
    await tx.payment.create({ data: { orderId, method: "COD", kind: "BALANCE", status: "PAID", amount: balance, currency: o.currency, verifiedAt: new Date(), rawResponse: { source: "ORDER_DELIVERED" } } });
  }
  await syncOrderPayment(tx, orderId);
}

/** True when the order still needs a verified advance before it may be confirmed. */
export function advanceOutstanding(o: {
  advanceRequired: unknown;
  advancePaid: unknown;
  advanceWaivedById: string | null;
}): boolean {
  return (
    Number(o.advanceRequired) > Number(o.advancePaid) && !o.advanceWaivedById
  );
}

/**
 * The phone the fraud check is about: the delivery phone captured at checkout. It lives in `shippingSnapshot` for EVERY order (guest orders have no
 * saved address row), so that is read first; a saved shipping address and the contact phone are only fallbacks for unusual older records.
 */
export function checkedPhoneOf(o: { shippingSnapshot?: unknown; shippingAddress?: { phone?: string | null } | null; phone?: string | null }): string | null {
  const snap = o.shippingSnapshot as { phone?: unknown } | null | undefined;
  if (snap && typeof snap.phone === "string" && snap.phone.trim() !== "") return snap.phone;
  return o.shippingAddress?.phone ?? o.phone ?? null;
}

export type PanelFraud = {
  status: "ok" | "no_history" | "unavailable" | null;
  reason: string | null;
  provider: string | null;
  delivered: number | null;
  cancelled: number | null;
  returned: number | null;
  total: number | null;
  /** null for orders placed before Phase 7.4 (not recorded). */
  source: "provider" | "fallback" | null;
  checkedAt: string | null;
  phoneVerified: boolean;
  phoneLast4: string | null;
};

type RawFraud = { status?: string; reason?: string | null; provider?: string | null; delivered?: number | null; cancelled?: number | null; returned?: number | null; total?: number | null; source?: string; checkedAt?: string | null; phoneVerified?: boolean; phoneLast4?: string | null };

/** Maps whatever was stored (older orders lack the newer fields) to the admin view. Unknown values become null, never a guess. */
function panelFraud(f: RawFraud): PanelFraud {
  return {
    status: f.status === "ok" || f.status === "no_history" || f.status === "unavailable" ? f.status : null,
    reason: f.reason ?? null,
    provider: f.provider ?? null,
    delivered: f.delivered ?? null,
    cancelled: f.cancelled ?? null,
    returned: f.returned ?? null,
    total: f.total ?? null,
    source: f.source === "provider" || f.source === "fallback" ? f.source : null,
    checkedAt: typeof f.checkedAt === "string" ? f.checkedAt : null,
    phoneVerified: Boolean(f.phoneVerified),
    phoneLast4: f.phoneLast4 ?? null,
  };
}

export type AdvancePanelData = {
  advanceRequired: number;
  advancePaid: number;
  total: number;
  remaining: number;
  trustScore: number | null;
  trust: {
    reasons: string[];
    tier: string | null;
    needsReview: boolean;
    explanation: string;
    insufficientEvidence: boolean;
    fraudCheck: PanelFraud | null;
    /** The most recent manual recheck by an admin (the order-time result above is never overwritten). */
    recheck: (PanelFraud & { score: number; tier: string; byId: string; insufficientEvidence: boolean; reasons: string[] }) | null;
  } | null;
  /** Phone the fraud check is about (the delivery phone on the order). ADMIN-only data. */
  phone: string | null;
  waived: { byId: string; reason: string; at: Date | null } | null;
  review: { required: boolean; reviewedAt: Date | null; reviewedById: string | null; note: string | null };
  /** Why dispatch is currently blocked (null = ready). */
  blockedReason: string | null;
  drift: boolean;
  audit: { action: string; actorId: string | null; at: Date; detail: unknown }[];
  payments: {
    id: string;
    method: string;
    status: string;
    amount: number;
    customerReference: string | null;
    providerRef: string | null;
    verifiedAt: Date | null;
    /** Other orders where somebody claimed the same reference: one transaction can only ever be verified on one of them. */
    sameReferenceOn: string[];
  }[];
};

/** Admin-only view: the snapshot taken at checkout (so the explanation stays valid even if the policy changes later). */
export async function getAdvancePanel(
  orderId: string,
): Promise<AdvancePanelData | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      total: true,
      advanceRequired: true,
      advancePaid: true,
      trustScore: true,
      trustSnapshot: true,
      advanceWaivedById: true,
      advanceWaivedReason: true,
      advanceWaivedAt: true,
      trustReviewRequired: true,
      trustReviewedById: true,
      trustReviewedAt: true,
      trustReviewNote: true,
      phone: true,
      shippingSnapshot: true,
      shippingAddress: { select: { phone: true } },
    },
  });
  if (!o) return null;
  const audit = await prisma.adminAuditEvent.findMany({ where: { entityType: "ORDER", entityId: orderId }, orderBy: { createdAt: "asc" }, take: 50 });
  const rowsPaid = (await prisma.payment.findMany({ where: { orderId, kind: "ADVANCE", status: "PAID" }, select: { amount: true } })).reduce((a, p) => a + Math.round(Number(p.amount) * 100), 0);
  const pays = await prisma.payment.findMany({
    where: { orderId, kind: "ADVANCE" },
    orderBy: { createdAt: "asc" },
  });
  // Other orders where the same transaction is claimed (compared NORMALISED, so spacing/case/dashes cannot hide it) or already verified.
  const norm = (v: string) => v.replace(/[\s-]+/g, "").toUpperCase();
  const claimsByRef = new Map<string, string[]>();
  const wanted = new Set(pays.filter((p) => p.customerReference).map((p) => norm(p.customerReference as string)));
  if (wanted.size > 0) {
    const others = await prisma.payment.findMany({
      where: { kind: "ADVANCE", orderId: { not: orderId }, status: { in: ["PENDING", "PAID"] } },
      select: { customerReference: true, providerRef: true, order: { select: { orderNumber: true } } },
      take: 1000,
    });
    for (const x of others) {
      for (const ref of [x.customerReference, x.providerRef]) {
        if (!ref || !wanted.has(norm(ref))) continue;
        const list = claimsByRef.get(norm(ref)) ?? [];
        if (!list.includes(x.order.orderNumber)) list.push(x.order.orderNumber);
        claimsByRef.set(norm(ref), list);
      }
    }
  }
  const snap = (o.trustSnapshot ?? null) as {
    reasons?: string[];
    tier?: string | null;
    needsReview?: boolean;
    explanation?: string;
    insufficientEvidence?: boolean;
    fraudCheck?: RawFraud;
    recheck?: RawFraud & { score?: number; tier?: string; byId?: string; insufficientEvidence?: boolean; reasons?: string[] };
  } | null;
  return {
    advanceRequired: Number(o.advanceRequired),
    advancePaid: Number(o.advancePaid),
    total: Number(o.total),
    remaining: Math.max(Number(o.total) - Number(o.advancePaid), 0),
    trustScore: o.trustScore,
    phone: checkedPhoneOf(o),
    trust: snap
      ? {
          reasons: snap.reasons ?? [],
          tier: snap.tier ?? null,
          needsReview: Boolean(snap.needsReview),
          explanation: snap.explanation ?? "",
          insufficientEvidence: Boolean(snap.insufficientEvidence),
          // Orders placed before the fraud checker existed have no such block: shown as "not recorded".
          fraudCheck: snap.fraudCheck ? panelFraud(snap.fraudCheck) : null,
          recheck: snap.recheck && typeof snap.recheck.score === "number"
            ? { ...panelFraud(snap.recheck), score: snap.recheck.score, tier: snap.recheck.tier ?? "", byId: snap.recheck.byId ?? "", insufficientEvidence: Boolean(snap.recheck.insufficientEvidence), reasons: snap.recheck.reasons ?? [] }
            : null,
        }
      : null,
    waived: o.advanceWaivedById
      ? { byId: o.advanceWaivedById, reason: o.advanceWaivedReason ?? "", at: o.advanceWaivedAt }
      : null,
    review: { required: o.trustReviewRequired, reviewedAt: o.trustReviewedAt, reviewedById: o.trustReviewedById, note: o.trustReviewNote },
    blockedReason: dispatchBlockedReason({ advanceRequired: o.advanceRequired, advancePaid: o.advancePaid, advanceWaivedById: o.advanceWaivedById, trustReviewRequired: o.trustReviewRequired, trustReviewedAt: o.trustReviewedAt }),
    drift: Math.round(Number(o.advancePaid) * 100) !== rowsPaid,
    audit: audit.map((e) => ({ action: e.action, actorId: e.actorId, at: e.createdAt, detail: e.detail })),
    payments: pays.map((p) => ({
      id: p.id,
      method: p.method,
      status: p.status,
      amount: Number(p.amount),
      customerReference: p.customerReference,
      providerRef: p.providerRef,
      verifiedAt: p.verifiedAt,
      sameReferenceOn: (p.customerReference ? claimsByRef.get(norm(p.customerReference)) ?? [] : []),
    })),
  };
}

/** Minimum gap between two checks of the same order (checkout lookup or recheck): protects the provider quota from a double click or a script. */
export const FRAUD_RECHECK_COOLDOWN_SECONDS = 60;

export type RecheckResult = { score: number; tier: string; status: FraudEvidence["status"]; reason: string | null; source: FraudEvidence["source"]; checkedAt: string };

/**
 * Admin-only manual recheck of the fraud result for an order. Calls the provider again (skipping the cache), stores the answer as the order's
 * `recheck` (the order-time result is never overwritten) and writes an audit event WITHOUT the phone number.
 *
 * It deliberately changes NOTHING else: not the advance already required or paid, not a waiver, not the review flag. A staff member reads the new
 * result and uses the existing review/waive actions. With no provider configured it still records an honest "unavailable (no provider)" result.
 */
export async function recheckOrderFraud(args: { orderId: string; adminId: string | null; now?: Date }): Promise<RecheckResult> {
  await assertAdminActor(prisma, args.adminId);
  const now = args.now ?? new Date();
  const o = await prisma.order.findUnique({ where: { id: args.orderId }, select: { id: true, trustSnapshot: true, phone: true, shippingSnapshot: true, shippingAddress: { select: { phone: true } } } });
  if (!o) throw new UserFacingError("Order not found.");
  const snap = (o.trustSnapshot ?? null) as { fraudCheck?: { checkedAt?: string }; recheck?: { checkedAt?: string }; rechecks?: unknown[] } | null;
  if (!snap) throw new UserFacingError("This order has no trust record (it was placed before the advance policy existed).");

  const lastMs = Math.max(...[snap.fraudCheck?.checkedAt, snap.recheck?.checkedAt].map((v) => (typeof v === "string" ? Date.parse(v) : Number.NaN)).filter((n) => Number.isFinite(n)), 0);
  const waitSeconds = Math.ceil((lastMs + FRAUD_RECHECK_COOLDOWN_SECONDS * 1000 - now.getTime()) / 1000);
  if (lastMs > 0 && waitSeconds > 0) throw new UserFacingError(`This order was checked a moment ago. Try again in ${waitSeconds} second${waitSeconds === 1 ? "" : "s"}.`);

  const phone = checkedPhoneOf(o);
  const lookup = await lookupFraudCheck(phone, { fresh: true });
  const phoneVerified = isPhoneVerified();
  const trust = trustFromOutcome(lookup, { phoneVerified });
  const settings = await getAdvanceSettings(prisma);
  const tier = tierForScore(settings, trust.score);
  // Stamp with the admin's own clock (a fresh lookup happens "now" anyway) so the cooldown below always compares like with like.
  const evidence = { ...fraudEvidence(lookup, phoneVerified, phone), checkedAt: now.toISOString() };
  const entry = { ...evidence, score: trust.score, tier, byId: args.adminId as string, insufficientEvidence: trust.insufficientEvidence, reasons: trust.reasons };

  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, args.adminId);
    await tx.order.update({
      where: { id: o.id },
      data: { trustSnapshot: { ...(snap as object), recheck: entry, rechecks: [...(Array.isArray(snap.rechecks) ? snap.rechecks : []).slice(-4), entry] } as unknown as Prisma.InputJsonValue },
    });
    await recordAudit(tx, {
      actorId: args.adminId,
      action: "FRAUD_RECHECK",
      entityType: "ORDER",
      entityId: o.id,
      detail: { status: evidence.status, reason: evidence.reason, provider: evidence.provider, source: evidence.source, score: trust.score, tier },
    });
  });
  return { score: trust.score, tier, status: evidence.status, reason: evidence.reason, source: evidence.source, checkedAt: evidence.checkedAt };
}
