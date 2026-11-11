import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import {
  validateIncident,
  type IncidentKindName,
  type StockEffectName,
} from "@/lib/incident";
import { applyStockDelta } from "@/server/services/stock-adjustment.service";
import { assertAdminActor, syncOrderPayment } from "@/server/services/advance.service";
import {
  checkLineStockEffect,
  goodsCanComeBack,
  remainingOut,
} from "@/lib/inventory-rules";
import type { OrderStatusName } from "@/lib/order-transitions";

export type IncidentFormInput = {
  kind: IncidentKindName;
  occurredOn: string;
  orderId?: string | null;
  orderItemId?: string | null;
  productId?: string | null;
  variantId?: string | null;
  quantity: number;
  stockEffect: StockEffectName;
  lossAmount: number;
  refundAmount: number;
  courierFee: number;
  note?: string | null;
  /** One key per form opening: a retry/double-click returns the first record instead of recording the event twice. */
  idempotencyKey?: string | null;
};

/**
 * Records a loss/return/refund and, when asked, its stock effect — all in ONE transaction, idempotent by `idempotencyKey`.
 *
 *  - RESTOCK  ("these returned units are SELLABLE"): needs the order line; only units that actually left stock and are still out can go back
 *    (`remainingOut` in src/lib/inventory-rules.ts), and only after the goods have shipped. The line's counters are advanced with a
 *    compare-and-set update, so two concurrent incidents cannot both restock the same unit, and a later cancel/refund can never restore it again.
 *  - DISCARD  ("returned but UNSELLABLE"): same cap; the units stay out of sellable stock for good.
 *  - WRITE_OFF removes units that are on the SHELF through the guarded decrement (never below zero); not allowed on an order line.
 *  - Refunds cannot exceed what was billed on the order in total.
 * For a COMPONENTS-policy combo the quantity is in whole combos: every component moves quantity × its units-per-combo.
 */
export async function recordIncident(
  input: IncidentFormInput,
  adminId: string | null,
): Promise<{ id: string; duplicate: boolean }> {
  // Incidents move stock and money records: only an active ADMIN may record one (re-checked here, not only in the server action).
  await assertAdminActor(prisma, adminId);
  const qty = Math.trunc(Number(input.quantity) || 0);
  const key = input.idempotencyKey?.trim()
    ? input.idempotencyKey.trim().slice(0, 80)
    : null;
  try {
    return await prisma.$transaction(async (tx) => {
      if (key) {
        const prior = await tx.financialIncident.findUnique({
          where: { idempotencyKey: key },
          select: { id: true },
        });
        if (prior) return { id: prior.id, duplicate: true };
      }
      let productId = input.productId || null;
      let variantId = input.variantId || null;
      let orderId = input.orderId || null;
      type Item = {
        id: string;
        orderId: string;
        productId: string;
        variantId: string | null;
        quantity: number;
        stockDeducted: number;
        procurementQty: number;
        procurementReceivedQty: number;
        stockReturnedQty: number;
        stockDiscardedQty: number;
        product: { type: string };
      };
      let item: Item | null = null;
      if (input.orderItemId) {
        // Serialise every incident on this line: a no-op write takes the row lock, then the counters are read fresh.
        const touched = await tx.orderItem.updateMany({
          where: { id: input.orderItemId },
          data: { stockReturnedQty: { increment: 0 } },
        });
        if (touched.count !== 1)
          throw new UserFacingError("That order line was not found.");
        item = await tx.orderItem.findUnique({
          where: { id: input.orderItemId },
          select: {
            id: true,
            orderId: true,
            productId: true,
            variantId: true,
            quantity: true,
            stockDeducted: true,
            procurementQty: true,
            procurementReceivedQty: true,
            stockReturnedQty: true,
            stockDiscardedQty: true,
            product: { select: { type: true } },
          },
        });
        if (!item) throw new UserFacingError("That order line was not found.");
        productId = item.productId;
        variantId = item.variantId;
        orderId = item.orderId;
      }
      const error = validateIncident({
        ...input,
        quantity: qty,
        hasOrderItem: Boolean(item),
        hasProduct: Boolean(productId),
      });
      if (error) throw new UserFacingError(error);

      let order: { id: string; total: unknown; status: string } | null = null;
      if (orderId) {
        order = await tx.order.findUnique({
          where: { id: orderId },
          select: { id: true, total: true, status: true },
        });
        if (!order) throw new UserFacingError("That order was not found.");
      }
      if (input.refundAmount > 0 && order) {
        const prior = await tx.financialIncident.findMany({
          where: { orderId: order.id },
          select: { refundAmount: true },
        });
        const refunded = prior.reduce((s, r) => s + Number(r.refundAmount), 0);
        if (
          Math.round((refunded + input.refundAmount) * 100) >
          Math.round(Number(order.total) * 100)
        )
          throw new UserFacingError(
            "Refunds on this order would exceed what the customer was billed.",
          );
      }

      // ---- plan the stock effect BEFORE writing anything
      const effect = input.stockEffect;
      type Move = {
        target: "COMPONENT" | "LINE";
        id: string;
        productId: string;
        variantId: string | null;
        productType: string;
        units: number;
      };
      const moves: Move[] = [];
      if ((effect === "RESTOCK" || effect === "DISCARD") && item && order) {
        const comps = await tx.orderItemComponent.findMany({
          where: { orderItemId: item.id },
          select: {
            id: true,
            productId: true,
            variantId: true,
            quantity: true,
            stockDeducted: true,
            procurementQty: true,
            procurementReceivedQty: true,
            stockReturnedQty: true,
            stockDiscardedQty: true,
            product: { select: { type: true } },
          },
        });
        const componentPolicy = comps.some(
          (c) => c.stockDeducted > 0 || c.procurementQty > 0,
        );
        const msg = checkLineStockEffect(
          effect,
          qty,
          { ...item, componentPolicy },
          order.status as OrderStatusName,
        );
        if (msg) throw new UserFacingError(msg);
        if (componentPolicy) {
          for (const c of comps) {
            const units = qty * c.quantity;
            // Pass quantity explicitly after ...c so it correctly overrides or provides the expected property
            const rem = remainingOut({ ...c, quantity: 0 }); // Or whatever quantity property `remainingOut` expects for components
            if (units > rem) {
              throw new UserFacingError(
                `Only ${rem} unit${rem === 1 ? "" : "s"} of "${c.productId}" in this combo can still be ${effect === "RESTOCK" ? "put back" : "marked unsellable"}.`,
              );
            }
            if (units > 0)
              moves.push({
                target: "COMPONENT",
                id: c.id,
                productId: c.productId,
                variantId: c.variantId,
                productType: c.product.type,
                units,
              });
          }
        } else {
          moves.push({
            target: "LINE",
            id: item.id,
            productId: item.productId,
            variantId: item.variantId,
            productType: item.product.type,
            units: qty,
          });
        }
      }

      const created = await tx.financialIncident.create({
        data: {
          kind: input.kind,
          occurredOn: new Date(`${input.occurredOn}T00:00:00.000Z`),
          orderId,
          orderItemId: item?.id ?? null,
          productId,
          variantId,
          quantity: qty,
          stockEffect: effect,
          lossAmount: input.lossAmount,
          refundAmount: input.refundAmount,
          courierFee: input.courierFee,
          note: input.note?.trim().slice(0, 500) || null,
          createdById: adminId,
          idempotencyKey: key,
        },
        select: { id: true },
      });

      // ---- execute it: counters first (compare-and-set), then stock + ledger
      if (
        item &&
        (effect === "RESTOCK" || effect === "DISCARD") &&
        moves.length > 0
      ) {
        // Compare-and-set on the counters we just read: if anything moved since, nothing is written.
        const bump = (n: number) =>
          effect === "RESTOCK"
            ? { stockReturnedQty: { increment: n } }
            : { stockDiscardedQty: { increment: n } };
        const cas = await tx.orderItem.updateMany({
          where: {
            id: item.id,
            stockReturnedQty: item.stockReturnedQty,
            stockDiscardedQty: item.stockDiscardedQty,
          },
          data: bump(qty),
        });
        if (cas.count !== 1)
          throw new UserFacingError(
            "This line was just updated by someone else. Reload and try again.",
          );
        // A combo line counts whole combos; each component counts its own units.
        if (moves[0].target === "COMPONENT")
          for (const m of moves)
            await tx.orderItemComponent.updateMany({
              where: { id: m.id },
              data: bump(m.units),
            });
        if (effect === "RESTOCK") {
          for (const m of moves) {
            if (m.variantId === null && m.productType === "VARIANT") continue; // a deleted variant has no stock row to credit
            await applyStockDelta(tx, {
              productId: m.productId,
              variantId: m.variantId,
              delta: m.units,
              reason: `Returned goods restocked as sellable (${input.kind})`,
              adminId,
              kind: "INCIDENT_RESTOCK",
              sourceType: "FINANCIAL_INCIDENT",
              sourceId: created.id,
              idempotencyKey: `INCIDENT:${created.id}:${m.target}:${m.id}`,
            });
          }
        }
      } else if (effect === "WRITE_OFF") {
        await applyStockDelta(tx, {
          productId: productId!,
          variantId,
          delta: -qty,
          reason: `Written off (${input.kind})`,
          adminId,
          kind: "INCIDENT_WRITE_OFF",
          sourceType: "FINANCIAL_INCIDENT",
          sourceId: created.id,
          idempotencyKey: `INCIDENT:${created.id}`,
        });
      }
      // A recorded refund changes the order's money position (PARTIALLY_REFUNDED / REFUNDED are derived from records, never typed in).
      if (order && input.refundAmount > 0) await syncOrderPayment(tx, order.id);
      return { id: created.id, duplicate: false };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "P2002"
    )
      throw new UserFacingError(
        "This record was just saved by someone else. Reload to see it.",
      );
    throw error;
  }
}

export async function listIncidents(range: { from: string; to: string }) {
  return prisma.financialIncident.findMany({
    where: {
      occurredOn: {
        gte: new Date(`${range.from}T00:00:00.000Z`),
        lte: new Date(`${range.to}T00:00:00.000Z`),
      },
    },
    orderBy: { occurredOn: "desc" },
    take: 200,
  });
}

export type GoodsStillOut = {
  lineId: string;
  productName: string;
  remaining: number;
  returned: number;
  discarded: number;
};

/**
 * Units of an order that have LEFT sellable stock and are not yet accounted for as back-in-stock or unsellable (combos count whole combos).
 * Empty for orders whose goods never left (they return automatically on cancel). Drives the admin prompt after a failed delivery / refund.
 */
export async function listGoodsStillOut(
  orderId: string,
): Promise<GoodsStillOut[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  });
  if (!order || !goodsCanComeBack(order.status as OrderStatusName)) return [];
  const items = await prisma.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      productName: true,
      quantity: true,
      stockDeducted: true,
      procurementQty: true,
      procurementReceivedQty: true,
      stockReturnedQty: true,
      stockDiscardedQty: true,
      components: { select: { stockDeducted: true, procurementQty: true } },
    },
  });
  return items
    .map((i) => {
      const componentPolicy = i.components.some(
        (c) => c.stockDeducted > 0 || c.procurementQty > 0,
      );
      return {
        lineId: i.id,
        productName: i.productName,
        remaining: remainingOut({ ...i, componentPolicy }),
        returned: i.stockReturnedQty,
        discarded: i.stockDiscardedQty,
      };
    })
    .filter((x) => x.remaining > 0);
}
