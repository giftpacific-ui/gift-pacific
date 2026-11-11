import "server-only";
import type { Prisma } from "@prisma/client";
import { deductionMode } from "@/lib/order-transitions";
import { outstandingProcurement, planRelease, remainingOut, type ReleaseMode } from "@/lib/inventory-rules";
import { recordMovementRow } from "@/server/services/stock-adjustment.service";
import { UserFacingError } from "@/lib/errors";

/**
 * Order inventory lifecycle — the ONLY code that changes stock because of an
 * order. See `lib/order-transitions.ts` for the full lifecycle description.
 */

export class InsufficientStockError extends UserFacingError {
  constructor(productName: string) {
    super(`"${productName}" just sold out while you were checking out. Please update your cart.`);
    this.name = "InsufficientStockError";
  }
}

export class ProcurementLimitError extends UserFacingError {
  constructor(productName: string) {
    super(`"${productName}" cannot take that many more advance orders right now. Please reduce the quantity.`);
    this.name = "ProcurementLimitError";
  }
}

export type StockLine = {
  productId: string;
  variantId: string | null;
  quantity: number;
  productName: string;
  trackInventory: boolean;
  allowBackorder: boolean;
  /** Cap on units pending procurement (null/undefined = no cap). Only used when allowBackorder is true. */
  procurementLimit?: number | null;
};

export type StockReservation = {
  /** Units taken from physical stock (OrderItem.stockDeducted). */
  deducted: number;
  /** Units accepted beyond stock, to be sourced (OrderItem.procurementQty). */
  procurement: number;
};

/**
 * Reserves stock for one order line inside the caller's transaction.
 *
 * INVARIANT: physical stock never goes negative (also enforced by a CHECK constraint).
 *  - Tracked, non-backorder: `updateMany WHERE stock >= quantity` — check + decrement are ONE atomic
 *    statement, so two concurrent checkouts for the last unit cannot both succeed.
 *  - Tracked + backorder/procurement enabled: take what physical stock has (same guarded statement), and
 *    the remainder is queued as `procurementPending` (guarded by the optional limit). If the limit would be
 *    exceeded the whole transaction fails, undoing the stock taken.
 *  - Untracked: never touched.
 */
export async function reserveStockForLine(tx: Prisma.TransactionClient, line: StockLine): Promise<StockReservation> {
  const mode = deductionMode(line);
  if (mode === "skip") return { deducted: 0, procurement: 0 };

  const isVariant = Boolean(line.variantId);
  const takeGuarded = async (amount: number) =>
    (isVariant
      ? await tx.productVariant.updateMany({ where: { id: line.variantId!, stock: { gte: amount } }, data: { stock: { decrement: amount } } })
      : await tx.product.updateMany({ where: { id: line.productId, stock: { gte: amount } }, data: { stock: { decrement: amount } } })
    ).count === 1;

  if (mode === "guarded") {
    if (!(await takeGuarded(line.quantity))) throw new InsufficientStockError(line.productName);
    return { deducted: line.quantity, procurement: 0 };
  }

  // Backorder / procurement: take as much physical stock as exists right now (re-read on contention).
  let taken = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = isVariant
      ? await tx.productVariant.findUnique({ where: { id: line.variantId! }, select: { stock: true } })
      : await tx.product.findUnique({ where: { id: line.productId }, select: { stock: true } });
    const want = Math.min(Math.max(row?.stock ?? 0, 0), line.quantity);
    if (want === 0) break;
    if (await takeGuarded(want)) { taken = want; break; }
  }
  const remainder = line.quantity - taken;
  if (remainder === 0) return { deducted: taken, procurement: 0 };

  const limit = line.procurementLimit ?? null;
  const pendingWhere = limit === null ? {} : { procurementPending: { lte: limit - remainder } };
  const queued = isVariant
    ? await tx.productVariant.updateMany({ where: { id: line.variantId!, ...pendingWhere }, data: { procurementPending: { increment: remainder } } })
    : await tx.product.updateMany({ where: { id: line.productId, ...pendingWhere }, data: { procurementPending: { increment: remainder } } });
  if (queued.count !== 1) throw new ProcurementLimitError(line.productName);
  return { deducted: taken, procurement: remainder };
}

/** Back-compat wrapper: units taken from stock only. New code should call reserveStockForLine. */
export async function deductStockForLine(tx: Prisma.TransactionClient, line: StockLine): Promise<number> {
  return (await reserveStockForLine(tx, line)).deducted;
}

/** Lowers procurementPending by `amount`, never below zero (guarded; clamps if the counter drifted). */
async function releasePending(tx: Prisma.TransactionClient, t: { productId: string; variantId: string | null }, amount: number) {
  if (amount <= 0) return;
  const ok = t.variantId
    ? await tx.productVariant.updateMany({ where: { id: t.variantId, procurementPending: { gte: amount } }, data: { procurementPending: { decrement: amount } } })
    : await tx.product.updateMany({ where: { id: t.productId, procurementPending: { gte: amount } }, data: { procurementPending: { decrement: amount } } });
  if (ok.count !== 1) {
    if (t.variantId) await tx.productVariant.updateMany({ where: { id: t.variantId }, data: { procurementPending: 0 } });
    else await tx.product.updateMany({ where: { id: t.productId }, data: { procurementPending: 0 } });
  }
}

/** Adds units back to sellable stock for one SKU. A VARIANT line whose variant was deleted has no stock row: never credit product-level stock. */
async function putBack(tx: Prisma.TransactionClient, t: { productId: string; variantId: string | null; productType: string }, amount: number): Promise<boolean> {
  if (amount <= 0) return false;
  if (t.variantId) return (await tx.productVariant.updateMany({ where: { id: t.variantId }, data: { stock: { increment: amount } } })).count === 1;
  if (t.productType === "VARIANT") return false;
  await tx.product.update({ where: { id: t.productId }, data: { stock: { increment: amount } } });
  return true;
}

/**
 * Closes an order's stock holding after a cancel/refund — at most once per line and per component.
 *
 *  - Every line/component is first CLAIMED with `UPDATE … WHERE stockRestoredAt IS NULL`; only the caller whose claim affects exactly one
 *    row acts, so repeated or concurrent calls cannot release twice.
 *  - mode FULL (the goods never left: PENDING/CONFIRMED/PROCESSING): puts back exactly `out − returned − discarded` — units an earlier incident
 *    already restocked or discarded are NOT restored again — and releases units still awaited from a supplier.
 *  - mode PENDING_ONLY (the goods shipped: FAILED_DELIVERY→CANCELLED, DELIVERED→REFUNDED): no unit is assumed to be back or sellable. Only units that
 *    never existed (still awaiting a supplier) are released; physical goods return through RESTOCK/DISCARD incidents.
 *  - Lines that took nothing from stock (untracked, `stockDeducted = 0`, nothing awaited) are never touched.
 * Returns the number of lines/components released.
 */
export async function restoreOrderStock(tx: Prisma.TransactionClient, orderId: string, mode: ReleaseMode = "FULL"): Promise<number> {
  let released = 0;

  // ---- plain lines (a COMPONENTS-policy combo line moves no stock itself: its components are handled below)
  const lines = await tx.orderItem.findMany({
    where: { orderId, stockRestoredAt: null, OR: [{ stockDeducted: { gt: 0 } }, { procurementQty: { gt: 0 } }] },
    select: {
      id: true, productId: true, variantId: true, quantity: true, stockDeducted: true, procurementQty: true, procurementReceivedQty: true,
      stockReturnedQty: true, stockDiscardedQty: true, product: { select: { type: true } },
    },
  });
  for (const line of lines) {
    const claim = await tx.orderItem.updateMany({ where: { id: line.id, stockRestoredAt: null }, data: { stockRestoredAt: new Date() } });
    if (claim.count !== 1) continue;
    const plan = planRelease(line, mode);
    if (plan.backToShelf > 0) {
      await tx.orderItem.updateMany({ where: { id: line.id }, data: { stockReturnedQty: { increment: plan.backToShelf } } });
      if (await putBack(tx, { productId: line.productId, variantId: line.variantId, productType: line.product.type }, plan.backToShelf)) {
        await recordMovementRow(tx, { productId: line.productId, variantId: line.variantId, delta: plan.backToShelf, kind: "ORDER_RELEASED", sourceType: "ORDER_ITEM", sourceId: line.id, reason: "Order cancelled before dispatch: units returned to stock", idempotencyKey: `RELEASE:${line.id}` });
      }
    }
    await releasePending(tx, line, plan.releasePending);
    released += 1;
  }

  // ---- component rows of COMPONENTS-policy combos (same claim-then-act rule; their parent line counts whole combos)
  const comps = await tx.orderItemComponent.findMany({
    where: { orderItem: { orderId }, stockRestoredAt: null, OR: [{ stockDeducted: { gt: 0 } }, { procurementQty: { gt: 0 } }] },
    select: {
      id: true, orderItemId: true, productId: true, variantId: true, stockDeducted: true, procurementQty: true, procurementReceivedQty: true,
      stockReturnedQty: true, stockDiscardedQty: true, product: { select: { type: true } },
    },
  });
  const parents = new Set<string>();
  for (const c of comps) {
    const claim = await tx.orderItemComponent.updateMany({ where: { id: c.id, stockRestoredAt: null }, data: { stockRestoredAt: new Date() } });
    if (claim.count !== 1) continue;
    const counters = { quantity: 0, stockDeducted: c.stockDeducted, procurementQty: c.procurementQty, procurementReceivedQty: c.procurementReceivedQty, stockReturnedQty: c.stockReturnedQty, stockDiscardedQty: c.stockDiscardedQty };
    const plan = planRelease(counters, mode);
    if (plan.backToShelf > 0) {
      await tx.orderItemComponent.updateMany({ where: { id: c.id }, data: { stockReturnedQty: { increment: plan.backToShelf } } });
      if (await putBack(tx, { productId: c.productId, variantId: c.variantId, productType: c.product.type }, plan.backToShelf)) {
        await recordMovementRow(tx, { productId: c.productId, variantId: c.variantId, delta: plan.backToShelf, kind: "ORDER_RELEASED", sourceType: "ORDER_ITEM_COMPONENT", sourceId: c.id, reason: "Order cancelled before dispatch: combo component returned to stock", idempotencyKey: `RELEASE_C:${c.id}` });
      }
    }
    await releasePending(tx, c, plan.releasePending);
    parents.add(c.orderItemId);
    released += 1;
  }
  // The parent combo line closes with its components: in FULL mode every combo still out counts as returned (blocks a later restock incident).
  for (const parentId of parents) {
    const claim = await tx.orderItem.updateMany({ where: { id: parentId, stockRestoredAt: null }, data: { stockRestoredAt: new Date() } });
    if (claim.count !== 1 || mode !== "FULL") continue;
    const parent = await tx.orderItem.findUnique({ where: { id: parentId }, select: { quantity: true, stockDeducted: true, procurementQty: true, procurementReceivedQty: true, stockReturnedQty: true, stockDiscardedQty: true } });
    if (!parent) continue;
    const left = remainingOut({ ...parent, componentPolicy: true });
    if (left > 0) await tx.orderItem.updateMany({ where: { id: parentId }, data: { stockReturnedQty: { increment: left } } });
  }
  return released;
}

/**
 * Writes the ledger rows (kind ORDER_PLACED) for the stock an order took at placement. The units were taken by guarded updates inside
 * the same transaction (see reserveStockForLine); this records WHY/WHICH for the audit trail. Idempotent by key.
 */
export async function recordPlacementMovements(tx: Prisma.TransactionClient, orderId: string, adminId: string | null = null): Promise<void> {
  const items = await tx.orderItem.findMany({ where: { orderId, stockDeducted: { gt: 0 } }, select: { id: true, productId: true, variantId: true, stockDeducted: true } });
  for (const i of items) {
    await recordMovementRow(tx, { productId: i.productId, variantId: i.variantId, delta: -i.stockDeducted, kind: "ORDER_PLACED", sourceType: "ORDER_ITEM", sourceId: i.id, reason: "Order placed: units reserved", adminId, idempotencyKey: `PLACE:${i.id}` });
  }
  const comps = await tx.orderItemComponent.findMany({ where: { orderItem: { orderId }, stockDeducted: { gt: 0 } }, select: { id: true, productId: true, variantId: true, stockDeducted: true } });
  for (const c of comps) {
    await recordMovementRow(tx, { productId: c.productId, variantId: c.variantId, delta: -c.stockDeducted, kind: "ORDER_PLACED", sourceType: "ORDER_ITEM_COMPONENT", sourceId: c.id, reason: "Order placed: combo component reserved", adminId, idempotencyKey: `PLACE_C:${c.id}` });
  }
}

/** Units of an order that are still waiting to be sourced (0 = nothing outstanding), lines AND combo components. Released/cancelled rows don't count. */
export async function outstandingProcurementForOrder(db: Pick<Prisma.TransactionClient, "orderItem" | "orderItemComponent">, orderId: string): Promise<number> {
  const rows = await db.orderItem.findMany({ where: { orderId, stockRestoredAt: null }, select: { procurementQty: true, procurementReceivedQty: true } });
  const comps = await db.orderItemComponent.findMany({ where: { orderItem: { orderId }, stockRestoredAt: null }, select: { procurementQty: true, procurementReceivedQty: true } });
  return [...rows, ...comps].reduce((sum, r) => sum + outstandingProcurement(r), 0);
}
