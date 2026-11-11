import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { assertAdminActor } from "@/server/services/advance.service";
import { applyStockDelta } from "@/server/services/stock-adjustment.service";
import { outstandingProcurement } from "@/lib/inventory-rules";

export const MAX_RECEIPT_QUANTITY = 100_000;

export type ReceiptResult = {
  receiptId: string;
  quantity: number;
  allocatedToOrders: number;
  addedToStock: number;
  /** True when this exact submission (same idempotency key) had already been recorded: nothing was changed. */
  duplicate?: boolean;
};

/**
 * Records sourced goods arriving for a product (or one variant).
 *
 * Conservation rule (no unit is ever counted twice):
 *   1. Units first satisfy orders that are WAITING for them (oldest first) — they are reserved for those
 *      orders and are NOT added to sellable stock;
 *   2. only the surplus is added to physical stock.
 * `procurementPending` falls by exactly the units allocated. Runs in one transaction; the pending decrement is
 * a guarded statement, so two concurrent receipts cannot allocate the same waiting units.
 *
 * Partial receipts are normal: only the quantity actually received is counted. A waiting line/component keeps
 * `procurementQty − procurementReceivedQty` outstanding (and its order stays blocked from dispatch) until the rest arrives.
 * Waiting rows are order LINES and COMBO COMPONENTS of this exact SKU, served oldest order first.
 * Idempotent: the same `idempotencyKey` returns the first receipt untouched.
 */
export async function receiveProcurement(args: {
  productId: string;
  variantId?: string | null;
  quantity: number;
  adminId: string | null;
  note?: string | null;
  /** Total purchase cost of this delivery of goods (cash out). Optional; unknown stays unknown. */
  totalCost?: number | null;
  idempotencyKey?: string | null;
}): Promise<ReceiptResult> {
  await assertAdminActor(prisma, args.adminId);
  const { productId } = args;
  const variantId = args.variantId ?? null;
  const quantity = args.quantity;
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_RECEIPT_QUANTITY
  ) {
    throw new UserFacingError(
      `Quantity must be a whole number between 1 and ${MAX_RECEIPT_QUANTITY}.`,
    );
  }
  const cost = args.totalCost ?? null;
  if (
    cost !== null &&
    (!Number.isFinite(cost) ||
      cost < 0 ||
      cost > 100_000_000 ||
      Math.round(cost * 100) / 100 !== cost)
  )
    throw new UserFacingError(
      "The purchase cost must be 0 or more, with at most 2 decimal places.",
    );
  const note = args.note?.trim() ? args.note.trim().slice(0, 300) : null;

  const key = args.idempotencyKey?.trim() ? args.idempotencyKey.trim().slice(0, 80) : null;
  try {
    return await prisma.$transaction(async (tx) => {
      if (key) {
        const prior = await tx.procurementReceipt.findUnique({ where: { idempotencyKey: key }, select: { id: true, quantity: true, allocatedToOrders: true, addedToStock: true } });
        if (prior) return { receiptId: prior.id, quantity: prior.quantity, allocatedToOrders: prior.allocatedToOrders, addedToStock: prior.addedToStock, duplicate: true };
      }
      const target = variantId
        ? await tx.productVariant.findFirst({ where: { id: variantId, productId }, select: { procurementPending: true } })
        : await tx.product.findUnique({ where: { id: productId }, select: { procurementPending: true } });
      if (!target) throw new UserFacingError("Product or variant not found.");

      // Everything of this exact SKU still waiting for goods: order lines and combo components, oldest order first.
      // Rows of cancelled/released orders are excluded (their units were released with the order).
      const lines = await tx.orderItem.findMany({
        where: { productId, variantId, stockRestoredAt: null, procurementQty: { gt: 0 } },
        select: { id: true, procurementQty: true, procurementReceivedQty: true, order: { select: { createdAt: true } } },
      });
      const comps = await tx.orderItemComponent.findMany({
        where: { productId, variantId, stockRestoredAt: null, procurementQty: { gt: 0 } },
        select: { id: true, procurementQty: true, procurementReceivedQty: true, orderItem: { select: { order: { select: { createdAt: true } } } } },
      });
      const waiting = [
        ...lines.map((l) => ({ kind: "LINE" as const, id: l.id, procurementQty: l.procurementQty, procurementReceivedQty: l.procurementReceivedQty, at: new Date(l.order.createdAt).getTime() })),
        ...comps.map((c) => ({ kind: "COMPONENT" as const, id: c.id, procurementQty: c.procurementQty, procurementReceivedQty: c.procurementReceivedQty, at: new Date(c.orderItem.order.createdAt).getTime() })),
      ].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

      let remaining = Math.min(quantity, target.procurementPending);
      let allocated = 0;
      for (const row of waiting) {
        if (remaining <= 0) break;
        const need = outstandingProcurement(row);
        if (need <= 0) continue;
        const give = Math.min(need, remaining);
        const where = { id: row.id, stockRestoredAt: null, procurementReceivedQty: row.procurementReceivedQty };
        const done = row.kind === "LINE"
          ? await tx.orderItem.updateMany({ where, data: { procurementReceivedQty: { increment: give } } })
          : await tx.orderItemComponent.updateMany({ where, data: { procurementReceivedQty: { increment: give } } });
        if (done.count !== 1) continue; // changed concurrently (e.g. cancelled): leave those units for stock
        allocated += give;
        remaining -= give;
      }

      if (allocated > 0) {
        const dec = variantId
          ? await tx.productVariant.updateMany({ where: { id: variantId, procurementPending: { gte: allocated } }, data: { procurementPending: { decrement: allocated } } })
          : await tx.product.updateMany({ where: { id: productId, procurementPending: { gte: allocated } }, data: { procurementPending: { decrement: allocated } } });
        if (dec.count !== 1) throw new UserFacingError("Pending quantities changed while receiving. Please try again.");
      }

      const surplus = quantity - allocated;
      const receipt = await tx.procurementReceipt.create({
        data: { productId, variantId, quantity, allocatedToOrders: allocated, addedToStock: surplus, totalCost: cost, adminId: args.adminId, note, idempotencyKey: key },
        select: { id: true },
      });
      if (surplus > 0) {
        await applyStockDelta(tx, {
          productId, variantId, delta: surplus, reason: `Procurement received${note ? `: ${note}` : ""}`, adminId: args.adminId,
          kind: "PROCUREMENT_RECEIVED", sourceType: "PROCUREMENT_RECEIPT", sourceId: receipt.id, idempotencyKey: `RECEIPT:${receipt.id}`,
        });
      }
      return { receiptId: receipt.id, quantity, allocatedToOrders: allocated, addedToStock: surplus };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") throw new UserFacingError("This receipt was just recorded by someone else. Reload to see it.");
    throw error;
  }
}
