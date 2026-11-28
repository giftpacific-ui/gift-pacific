import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { assertAdminActor, recordAudit, recordCodCollection } from "@/server/services/advance.service";
import {
  COD_FLAG_LABEL_P5, REMITTANCE_LABEL, PENDING_REMITTANCE, collectionConfirmable, expectedCod, reconcileCod, validateCodEntry, validateCodResolution, writtenOffShortfall,
  type CodFlagCodeP5, type CodFlagP5, type RemittanceStatus,
} from "@/lib/courier/cod-reconciliation";

/**
 * Append-only: one INSERT per call. An entry is refused when the same kind + reference was already recorded for the
 * order (a repeated submission or re-keyed statement line), and every entry writes an audit event in the same transaction.
 */
export async function recordCodEntry(args: { orderId: string; adminId: string; kind: unknown; amount: unknown; reference?: unknown; note?: unknown }) {
  const valid = validateCodEntry(args);
  if (!valid.ok) throw new UserFacingError(valid.message);

  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, args.adminId);
    // Serialize entries for one order so the duplicate check and the insert cannot interleave.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cod:${args.orderId}`}))`;
    const order = await tx.order.findUnique({ where: { id: args.orderId }, select: { paymentMethod: true, courierBookingStatus: true, courierProvider: true } });
    if (!order) throw new UserFacingError("Order not found.");
    if (order.paymentMethod !== "COD") throw new UserFacingError("Only cash-on-delivery orders have courier COD records.");
    if (order.courierBookingStatus !== "BOOKED" && order.courierBookingStatus !== "MANUAL") {
      throw new UserFacingError("This order has not been handed to a courier.");
    }
    if (valid.reference) {
      const dup = await tx.courierCodEntry.findFirst({ where: { orderId: args.orderId, kind: valid.kind, reference: valid.reference }, select: { id: true } });
      if (dup) throw new UserFacingError("That entry (same type and reference) was already recorded for this order.");
    }
    const entry = await tx.courierCodEntry.create({
      data: { orderId: args.orderId, kind: valid.kind, amount: valid.amount, provider: order.courierProvider, reference: valid.reference, note: valid.note, createdById: args.adminId },
    });
    await recordAudit(tx, {
      actorId: args.adminId,
      action: "COURIER_COD_ENTRY",
      entityType: "ORDER",
      entityId: args.orderId,
      detail: { entryId: entry.id, kind: valid.kind, amount: valid.amount, reference: valid.reference },
    });
  });
}

const PAGE_SIZE = 25;
/** Only this many of the most recent candidate orders are examined per request (bounded memory). */
const CANDIDATE_CAP = 500;

const cents = (n: number) => Math.round(n * 100);

const codSelect = {
  id: true, orderNumber: true, status: true, total: true, advancePaid: true, paymentMethod: true, shippingTotal: true,
  courierProvider: true, trackingNumber: true, courierCodAmount: true,
  trackingEvents: { where: { status: "DELIVERED" }, orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } },
  codEntries: { orderBy: { createdAt: "asc" }, select: { id: true, kind: true, amount: true, reference: true, note: true, createdAt: true } },
  codResolutions: { orderBy: { createdAt: "asc" }, select: { id: true, flagCode: true, amount: true, action: true, reason: true, resolvedById: true, createdAt: true } },
  payments: { where: { kind: "BALANCE", status: "PAID" }, select: { id: true } },
  shipmentEvents: { orderBy: { createdAt: "desc" }, take: 1, where: { outcome: { in: ["APPLIED", "RECORDED"] as string[] } }, select: { mappedEvent: true } },
} as const;

type CodOrder = {
  id: string; orderNumber: string; status: string; total: unknown; advancePaid: unknown; paymentMethod: string; shippingTotal: unknown;
  courierProvider: string | null; trackingNumber: string | null; courierCodAmount: unknown;
  trackingEvents: { createdAt: Date }[];
  codEntries: { id: string; kind: string; amount: unknown; reference: string | null; note: string | null; createdAt: Date }[];
  codResolutions: { id: string; flagCode: string; amount: unknown; action: string; reason: string; resolvedById: string; createdAt: Date }[];
  payments: { id: string }[];
  shipmentEvents: { mappedEvent: string }[];
};

/** One order's COD position, computed by the single rule set in lib/courier/cod-reconciliation.ts. */
function codPosition(o: CodOrder) {
  const expected = expectedCod(o);
  return reconcileCod({
    expected,
    orderDelivered: o.status === "DELIVERED",
    paymentRecorded: o.payments.length > 0,
    courierCodAmount: o.courierCodAmount === null || o.courierCodAmount === undefined ? null : Number(o.courierCodAmount),
    partialDelivery: o.shipmentEvents[0]?.mappedEvent === "PARTIAL_DELIVERED" && o.status !== "DELIVERED",
    entries: o.codEntries,
    resolutions: o.codResolutions,
  });
}

export type CodRow = {
  id: string;
  orderNumber: string;
  status: string;
  deliveredAt: Date | null;
  provider: string | null;
  tracking: string | null;
  deliveryCharge: number;
  expected: number;
  /** COD amount the courier holds for the consignment (a consignment figure, not collected cash). */
  courierAmount: number | null;
  collected: number;
  fees: number;
  settled: number;
  outstanding: number;
  /** Open (unresolved) flags. */
  flags: { code: CodFlagCodeP5; amount: number }[];
  resolved: { code: CodFlagCodeP5; amount: number }[];
  remittance: RemittanceStatus;
  /** The COD balance payment record exists (the financial source of truth that cash was collected). */
  paymentRecorded: boolean;
  entries: { id: string; kind: string; amount: number; reference: string | null; note: string | null; createdAt: Date }[];
  resolutions: { id: string; flagCode: string; amount: number; action: string; reason: string; createdAt: Date }[];
};

export type CodListFilter = { flag?: CodFlagCodeP5 | "ANY" | "ALL"; remittance?: RemittanceStatus | "PENDING" | "ALL" };

/**
 * COD orders handed to a courier that are delivered (or already have entries / a partial delivery), with expected vs reported vs settled.
 * `flag` narrows to one OPEN discrepancy type; `remittance` narrows to a derived remittance status ("PENDING" = everything not settled).
 * Delivery charge is shown for reference only and is never mixed into the COD math.
 */
export async function listCodReconciliation(flag: CodFlagCodeP5 | "ANY" | "ALL" = "ALL", page = 1, remittance: CodListFilter["remittance"] = "ALL") {
  const orders = (await prisma.order.findMany({
    where: {
      paymentMethod: "COD",
      courierBookingStatus: { in: ["BOOKED", "MANUAL"] },
      OR: [{ status: "DELIVERED" }, { codEntries: { some: {} } }, { shipmentEvents: { some: { mappedEvent: "PARTIAL_DELIVERED" } } }],
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_CAP,
    select: codSelect,
  })) as unknown as CodOrder[];

  const rows: CodRow[] = orders.map((o) => {
    const pos = codPosition(o);
    return {
      id: o.id, orderNumber: o.orderNumber, status: o.status,
      deliveredAt: o.trackingEvents[0]?.createdAt ?? null,
      provider: o.courierProvider, tracking: o.trackingNumber, deliveryCharge: Number(o.shippingTotal),
      expected: pos.expected, courierAmount: o.courierCodAmount === null || o.courierCodAmount === undefined ? null : Number(o.courierCodAmount),
      collected: pos.collected, fees: pos.fees, settled: pos.settled, outstanding: pos.outstanding,
      flags: pos.flags, resolved: pos.resolvedFlags, remittance: pos.status, paymentRecorded: o.payments.length > 0,
      entries: o.codEntries.map((e) => ({ id: e.id, kind: e.kind, amount: Number(e.amount), reference: e.reference, note: e.note, createdAt: e.createdAt })),
      resolutions: o.codResolutions.map((r) => ({ id: r.id, flagCode: r.flagCode, amount: Number(r.amount), action: r.action, reason: r.reason, createdAt: r.createdAt })),
    };
  });

  const byFlag = flag === "ALL" ? rows : flag === "ANY" ? rows.filter((r) => r.flags.length > 0) : rows.filter((r) => r.flags.some((f) => f.code === flag));
  const filtered =
    remittance === "ALL" ? byFlag
    : remittance === "PENDING" ? byFlag.filter((r) => PENDING_REMITTANCE.includes(r.remittance))
    : byFlag.filter((r) => r.remittance === remittance);
  const totals = {
    orders: rows.length,
    flagged: rows.filter((r) => r.flags.length > 0).length,
    pending: rows.filter((r) => PENDING_REMITTANCE.includes(r.remittance)).length,
    outstanding: Math.round(rows.reduce((s, r) => s + Math.max(r.outstanding, 0), 0) * 100) / 100,
  };
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  return {
    rows: filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    total: filtered.length,
    page: safePage,
    pageCount: Math.ceil(filtered.length / PAGE_SIZE),
    totals,
    capped: orders.length === CANDIDATE_CAP,
  };
}

/** COD position of one order for the order page (admin only). Null when the order has no COD to reconcile. */
export async function codStateForOrder(orderId: string) {
  const o = (await prisma.order.findUnique({ where: { id: orderId }, select: codSelect })) as unknown as CodOrder | null;
  if (!o || o.paymentMethod !== "COD") return null;
  const pos = codPosition(o);
  return {
    status: pos.status,
    label: REMITTANCE_LABEL[pos.status],
    expected: pos.expected,
    courierAmount: o.courierCodAmount === null || o.courierCodAmount === undefined ? null : Number(o.courierCodAmount),
    collected: pos.collected,
    settled: pos.settled,
    outstanding: pos.outstanding,
    paymentRecorded: o.payments.length > 0,
    openFlags: pos.flags.map((f) => ({ code: f.code, label: COD_FLAG_LABEL_P5[f.code], amount: f.amount })),
    resolved: pos.resolvedFlags.map((f) => ({ code: f.code, label: COD_FLAG_LABEL_P5[f.code], amount: f.amount })),
    canConfirmCollection: o.status === "DELIVERED" && pos.expected > 0 && o.payments.length === 0 && collectionConfirmable(pos.flags).ok && !writtenOffShortfall(pos.resolvedFlags, o.codResolutions),
  };
}

async function loadForUpdate(tx: Pick<typeof prisma, "order" | "$executeRaw">, orderId: string): Promise<CodOrder> {
  // Same advisory lock as recordCodEntry: entries, confirmations and resolutions for one order never interleave.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cod:${orderId}`}))`;
  const o = (await tx.order.findUnique({ where: { id: orderId }, select: codSelect })) as unknown as CodOrder | null;
  if (!o) throw new UserFacingError("Order not found.");
  return o;
}

/**
 * An admin's explicit statement that the cash for a courier-DELIVERED COD order was collected. This is the ONLY way a courier-delivered order
 * becomes PAID: it records the COD balance payment through the same function an admin "Delivered" uses (recordCodCollection), so the existing
 * financial records stay the source of truth. Needs a reason, an order that is DELIVERED and not yet paid, and no open short collection or
 * partial delivery. Audited. Idempotent: a second confirmation is refused.
 */
export async function confirmCodCollection(args: { orderId: string; adminId: string; reason: unknown }) {
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (reason.length < 10) throw new UserFacingError("Write what you checked (e.g. the courier's statement line or the cash received), at least 10 characters.");
  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, args.adminId);
    const o = await loadForUpdate(tx, args.orderId);
    if (o.paymentMethod !== "COD") throw new UserFacingError("Only cash-on-delivery orders have COD to confirm.");
    if (o.status !== "DELIVERED") throw new UserFacingError("Only a delivered order's cash can be confirmed.");
    if (o.payments.length > 0) throw new UserFacingError("The cash collection for this order is already recorded.");
    const pos = codPosition(o);
    if (pos.expected <= 0) throw new UserFacingError("There is no cash to collect on this order.");
    const ok = collectionConfirmable(pos.flags);
    if (!ok.ok) throw new UserFacingError(ok.message);
    if (writtenOffShortfall(pos.resolvedFlags, o.codResolutions)) {
      throw new UserFacingError("A shortfall on this order was written off, so the cash was NOT fully received and the order cannot be recorded as fully collected here. Handle the loss through a financial incident instead.");
    }
    await recordCodCollection(tx, args.orderId);
    await recordAudit(tx, {
      actorId: args.adminId, action: "COURIER_COD_CONFIRMED", entityType: "ORDER", entityId: args.orderId,
      detail: { reason: reason.slice(0, 300), expected: pos.expected, reportedCollected: pos.collected, hadCollectionReport: o.codEntries.some((e) => e.kind === "COLLECTION_REPORTED") },
    });
  });
}

/**
 * Records an admin's decision on ONE open COD discrepancy. The reason is mandatory and stored; nothing else is edited (entries and payment
 * records are never touched). The caller passes the amount it was shown: if the discrepancy changed since, the request is refused so a decision
 * can never be applied to something the admin did not review. Append-only and audited.
 */
export async function resolveCodDiscrepancy(args: { orderId: string; adminId: string; flagCode: unknown; amount: unknown; action: unknown; reason: unknown }) {
  const valid = validateCodResolution(args);
  if (!valid.ok) throw new UserFacingError(valid.message);
  const shown = Number(args.amount);
  if (!Number.isFinite(shown)) throw new UserFacingError("The discrepancy amount is missing.");
  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, args.adminId);
    const o = await loadForUpdate(tx, args.orderId);
    const pos = codPosition(o);
    const flag: CodFlagP5 | undefined = pos.flags.find((f) => f.code === valid.flagCode);
    if (!flag) throw new UserFacingError("That discrepancy is no longer open.");
    if (cents(flag.amount) !== cents(shown)) throw new UserFacingError("This discrepancy changed since you opened it. Refresh and review it again.");
    try {
      await tx.courierCodResolution.create({
        data: { orderId: args.orderId, flagCode: valid.flagCode, amount: flag.amount, amountCents: cents(flag.amount), action: valid.action, reason: valid.reason, resolvedById: args.adminId },
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw new UserFacingError("This discrepancy was already resolved.");
      throw error;
    }
    await recordAudit(tx, {
      actorId: args.adminId, action: "COURIER_COD_RESOLVED", entityType: "ORDER", entityId: args.orderId,
      detail: { flag: valid.flagCode, amount: flag.amount, action: valid.action, reason: valid.reason },
    });
  });
}
