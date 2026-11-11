import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";
import { expectedCod, summarizeCod, validateCodEntry, type CodFlagCode } from "@/lib/courier/cod-reconciliation";

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

export type CodRow = {
  id: string;
  orderNumber: string;
  status: string;
  deliveredAt: Date | null;
  provider: string | null;
  tracking: string | null;
  deliveryCharge: number;
  expected: number;
  collected: number;
  fees: number;
  settled: number;
  outstanding: number;
  flags: { code: CodFlagCode; amount: number }[];
  entries: { id: string; kind: string; amount: number; reference: string | null; note: string | null; createdAt: Date }[];
};

/**
 * COD orders handed to a courier that are delivered (or already have entries), with expected vs reported vs settled.
 * `flag` narrows to one discrepancy type. Delivery charge is shown for reference only and is never mixed into the COD math.
 */
export async function listCodReconciliation(flag: CodFlagCode | "ANY" | "ALL" = "ALL", page = 1) {
  const orders = await prisma.order.findMany({
    where: {
      paymentMethod: "COD",
      courierBookingStatus: { in: ["BOOKED", "MANUAL"] },
      OR: [{ status: "DELIVERED" }, { codEntries: { some: {} } }],
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_CAP,
    select: {
      id: true, orderNumber: true, status: true, total: true, advancePaid: true, paymentMethod: true, shippingTotal: true,
      courierProvider: true, trackingNumber: true,
      trackingEvents: { where: { status: "DELIVERED" }, orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } },
      codEntries: { orderBy: { createdAt: "asc" }, select: { id: true, kind: true, amount: true, reference: true, note: true, createdAt: true } },
    },
  });

  const rows: CodRow[] = orders.map((o) => {
    const expected = expectedCod(o);
    const summary = summarizeCod(expected, o.status === "DELIVERED", o.codEntries);
    return {
      id: o.id, orderNumber: o.orderNumber, status: o.status,
      deliveredAt: o.trackingEvents[0]?.createdAt ?? null,
      provider: o.courierProvider, tracking: o.trackingNumber, deliveryCharge: Number(o.shippingTotal),
      expected, collected: summary.collected, fees: summary.fees, settled: summary.settled, outstanding: summary.outstanding, flags: summary.flags,
      entries: o.codEntries.map((e) => ({ id: e.id, kind: e.kind, amount: Number(e.amount), reference: e.reference, note: e.note, createdAt: e.createdAt })),
    };
  });

  const filtered = flag === "ALL" ? rows : flag === "ANY" ? rows.filter((r) => r.flags.length > 0) : rows.filter((r) => r.flags.some((f) => f.code === flag));
  const totals = {
    orders: rows.length,
    flagged: rows.filter((r) => r.flags.length > 0).length,
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
