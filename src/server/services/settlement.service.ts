import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { assertAdminActor } from "@/server/services/advance.service";
import { NON_SALE_STATUSES } from "@/lib/accounting";
import { fromPaisa, toPaisa } from "@/lib/money";
import { expectedPayoutPaisa, settlementState, validateSettlementInput, type SettlementInput, type SettlementState } from "@/lib/settlement";

type Db = Pick<Prisma.TransactionClient, "order" | "marketplaceSettlement">;
const uniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
const day = (d: Date | string) => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

/**
 * Recomputes the cached Order.settlementStatus / settledAt from the payout rows and the CURRENT expected payout.
 * Call it inside the same transaction whenever something that changes either side is written (a payout row, a cost line,
 * the order being created). The rows are the source of truth; the column only makes lists cheap to filter.
 */
export async function refreshSettlementStatus(tx: Db, orderId: string): Promise<{ state: SettlementState; expected: number; received: number } | null> {
  const o = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, total: true, advancePaid: true, settlementStatus: true, settledAt: true,
      channel: { select: { kind: true } }, costLines: { select: { kind: true, amount: true } }, settlements: { select: { amount: true } },
    },
  });
  if (!o || o.channel.kind !== "MARKETPLACE") return null;
  const expected = expectedPayoutPaisa({ total: Number(o.total), advancePaid: Number(o.advancePaid), costLines: o.costLines.map((c) => ({ kind: c.kind, amount: Number(c.amount) })) });
  const received = o.settlements.reduce((s, x) => s + toPaisa(Number(x.amount)), 0);
  const state = settlementState(expected, received);
  if (state !== o.settlementStatus) {
    await tx.order.update({ where: { id: o.id }, data: { settlementStatus: state, settledAt: state === "SETTLED" ? (o.settledAt ?? new Date()) : null } });
  }
  return { state, expected: fromPaisa(expected), received: fromPaisa(received) };
}

export type SettlementResult = { id: string; duplicate: boolean; state: SettlementState; expected: number; received: number; remaining: number };

/**
 * Records a payout the marketplace ACTUALLY sent. Nothing is assumed: the amount, the date and (ideally) the marketplace's
 * payout reference are entered by a person.
 *
 *  - ONE transaction. The order row is locked first (a no-op write), so two admins recording at once are serialised and the
 *    cap below is checked against fresh totals.
 *  - Idempotent: the same `idempotencyKey` returns the original entry instead of creating a second one (double-click / retry).
 *  - Duplicates refused: the same reference on the same order; or, with no reference, the same amount on the same date.
 *  - The total received can never exceed the expected payout. If the marketplace really deducted more than the recorded
 *    commission, correct the commission cost line first — that lowers the expected payout.
 *  - A partial payout leaves the remainder receivable; the order becomes SETTLED only when the expected payout has arrived.
 */
export async function recordSettlement(raw: Partial<SettlementInput>, adminId: string | null): Promise<SettlementResult> {
  await assertAdminActor(prisma, adminId);
  const parsed = validateSettlementInput(raw);
  if (!parsed.ok) throw new UserFacingError(parsed.message);
  const input = parsed.value;

  try {
    return await prisma.$transaction(async (tx) => {
      if (input.idempotencyKey) {
        const prior = await tx.marketplaceSettlement.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true, orderId: true } });
        if (prior) {
          if (prior.orderId !== input.orderId) throw new UserFacingError("That submission was already used for a different order. Reload the page and try again.");
          const r = await refreshSettlementStatus(tx, prior.orderId);
          return { id: prior.id, duplicate: true, state: r?.state ?? "PENDING", expected: r?.expected ?? 0, received: r?.received ?? 0, remaining: Math.max((r?.expected ?? 0) - (r?.received ?? 0), 0) };
        }
      }

      // Lock the order row for the rest of the transaction.
      const locked = await tx.order.updateMany({ where: { id: input.orderId }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new UserFacingError("Order not found.");

      const o = await tx.order.findUniqueOrThrow({
        where: { id: input.orderId },
        select: {
          id: true, orderNumber: true, status: true, total: true, advancePaid: true,
          channel: { select: { kind: true, name: true } },
          costLines: { select: { kind: true, amount: true } },
          settlements: { select: { amount: true, reference: true, receivedOn: true } },
        },
      });
      if (o.channel.kind !== "MARKETPLACE") throw new UserFacingError("Payouts are only recorded for marketplace orders.");
      if ((NON_SALE_STATUSES as readonly string[]).includes(o.status)) throw new UserFacingError(`${o.orderNumber} is ${o.status.toLowerCase().replaceAll("_", " ")}: a payout cannot be recorded against an order that no longer counts as a sale.`);

      if (input.reference && o.settlements.some((s) => s.reference === input.reference)) throw new UserFacingError(`Payout reference ${input.reference} is already recorded for ${o.orderNumber}.`);
      const amountP = toPaisa(input.amount);
      if (!input.reference && o.settlements.some((s) => toPaisa(Number(s.amount)) === amountP && day(s.receivedOn) === input.receivedOn)) {
        throw new UserFacingError("An identical payout (same amount, same date) is already recorded for this order. If the marketplace really paid twice, add its payout reference to the second entry.");
      }

      const expected = expectedPayoutPaisa({ total: Number(o.total), advancePaid: Number(o.advancePaid), costLines: o.costLines.map((c) => ({ kind: c.kind, amount: Number(c.amount) })) });
      const received = o.settlements.reduce((s, x) => s + toPaisa(Number(x.amount)), 0);
      if (received + amountP > expected) {
        const remaining = Math.max(expected - received, 0);
        throw new UserFacingError(
          remaining === 0
            ? `${o.orderNumber} has already received its full expected payout (${fromPaisa(expected)}). If the marketplace deducted more than the recorded commission, correct the commission first.`
            : `That is more than ${o.channel.name} still owes on ${o.orderNumber}: expected ${fromPaisa(expected)}, already received ${fromPaisa(received)}, remaining ${fromPaisa(remaining)}. If the marketplace deducted more than the recorded commission, correct the commission first.`,
        );
      }

      const row = await tx.marketplaceSettlement.create({
        data: { orderId: o.id, amount: input.amount, receivedOn: new Date(`${input.receivedOn}T00:00:00.000Z`), reference: input.reference, idempotencyKey: input.idempotencyKey, note: input.note, recordedById: adminId },
        select: { id: true },
      });
      const r = await refreshSettlementStatus(tx, o.id);
      return { id: row.id, duplicate: false, state: r?.state ?? "PENDING", expected: r?.expected ?? 0, received: r?.received ?? 0, remaining: Math.max((r?.expected ?? 0) - (r?.received ?? 0), 0) };
    });
  } catch (error) {
    // Two identical submissions racing: the unique indexes let exactly one through.
    if (uniqueViolation(error)) throw new UserFacingError("This payout was just recorded by someone else. Reload to see it.");
    throw error;
  }
}

export type OpenReceivable = {
  orderId: string; orderNumber: string; externalOrderRef: string | null; channelName: string; placedOn: string;
  total: number; advancePaid: number; feesWithheld: number; expected: number; received: number; remaining: number; state: SettlementState;
  payouts: { amount: number; receivedOn: string; reference: string | null; legacyAssumed: boolean }[];
};

/** Sold marketplace orders that still have something to receive (PENDING or PARTIAL), oldest first. */
export async function listOpenReceivables(limit = 100): Promise<OpenReceivable[]> {
  const rows = await prisma.order.findMany({
    where: { channel: { kind: "MARKETPLACE" }, settlementStatus: { in: ["PENDING", "PARTIAL"] }, status: { notIn: [...NON_SALE_STATUSES] } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true, orderNumber: true, externalOrderRef: true, externalPlacedAt: true, createdAt: true, total: true, advancePaid: true,
      channel: { select: { name: true } }, costLines: { select: { kind: true, amount: true } },
      settlements: { select: { amount: true, receivedOn: true, reference: true, legacyAssumed: true }, orderBy: { receivedOn: "asc" } },
    },
  });
  return rows.map((o) => {
    const costLines = o.costLines.map((c) => ({ kind: c.kind, amount: Number(c.amount) }));
    const expected = expectedPayoutPaisa({ total: Number(o.total), advancePaid: Number(o.advancePaid), costLines });
    const received = o.settlements.reduce((s, x) => s + toPaisa(Number(x.amount)), 0);
    return {
      orderId: o.id, orderNumber: o.orderNumber, externalOrderRef: o.externalOrderRef, channelName: o.channel.name,
      placedOn: day(o.externalPlacedAt ?? o.createdAt), total: Number(o.total), advancePaid: Number(o.advancePaid),
      feesWithheld: fromPaisa(costLines.reduce((s, c) => (["MARKETPLACE_COMMISSION", "PAYMENT_FEE"].includes(c.kind) ? s + toPaisa(c.amount) : s), 0)),
      expected: fromPaisa(expected), received: fromPaisa(received), remaining: fromPaisa(Math.max(expected - received, 0)), state: settlementState(expected, received),
      payouts: o.settlements.map((s) => ({ amount: Number(s.amount), receivedOn: day(s.receivedOn), reference: s.reference, legacyAssumed: s.legacyAssumed })),
    };
  });
}
