import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { assertAdminActor } from "@/server/services/advance.service";
import { validateAdjustment } from "@/lib/stock-adjustment";

/**
 * STOCK LEDGER. Every change to sellable stock has a StockAdjustment row saying WHY (`kind`), WHICH record caused it
 * (`sourceType` + `sourceId`) and, where a retry is possible, a unique `idempotencyKey` — so the same cause cannot move stock twice.
 *
 *   kind                      source                         written by
 *   MANUAL_ADJUSTMENT         admin (key = form submission)  adjustStock
 *   ORDER_PLACED   (−)        OrderItem / component          recordPlacementMovements (after checkout / external order)
 *   ORDER_RELEASED (+)        OrderItem / component          restoreOrderStock (cancel before the goods left)
 *   INCIDENT_RESTOCK (+)      FinancialIncident              recordIncident
 *   INCIDENT_WRITE_OFF (−)    FinancialIncident              recordIncident
 *   PROCUREMENT_RECEIVED (+)  ProcurementReceipt             receiveProcurement (only the surplus: units given to waiting orders never enter stock)
 *   RECONCILE_LEGACY_BACKORDER (0)  OrderItem                audit row of a counters-only legacy correction
 *
 * The stock numbers themselves are moved by guarded UPDATEs (never read-modify-write); the ledger row is the audit trail.
 */

export type MovementKind =
  | "MANUAL_ADJUSTMENT"
  | "ORDER_PLACED"
  | "ORDER_RELEASED"
  | "INCIDENT_RESTOCK"
  | "INCIDENT_WRITE_OFF"
  | "PROCUREMENT_RECEIVED"
  | "RECONCILE_LEGACY_BACKORDER";

export type MovementMeta = { kind?: MovementKind; sourceType?: string; sourceId?: string; idempotencyKey?: string | null };

type Target = { productId: string; variantId: string | null };

/**
 * Applies a relative change atomically and records it. Increases always
 * work; decreases are a guarded `UPDATE … WHERE stock >= amount`, so a manual
 * adjustment can never drive stock below zero or race an order into it.
 * Runs inside the caller's transaction.
 */
export async function applyStockDelta(
  tx: Prisma.TransactionClient,
  args: Target & MovementMeta & { delta: number; reason: string; adminId: string | null },
): Promise<number> {
  const { productId, variantId, delta } = args;
  const key = args.idempotencyKey?.trim() || null;
  // Idempotent: the same key has already moved stock, so this call changes nothing and reports the recorded outcome.
  if (key) {
    const prior = await tx.stockAdjustment.findUnique({ where: { idempotencyKey: key }, select: { stockAfter: true } });
    if (prior) return prior.stockAfter;
  }
  const where = variantId ? { id: variantId, productId } : { id: productId };
  const guarded = delta < 0 ? { ...where, stock: { gte: -delta } } : where;

  const result = variantId
    ? await tx.productVariant.updateMany({ where: guarded, data: { stock: { increment: delta } } })
    : await tx.product.updateMany({ where: guarded, data: { stock: { increment: delta } } });

  if (result.count !== 1) {
    throw new UserFacingError(
      delta < 0
        ? "Not enough stock to remove that many units (stock may have changed — reload and try again)."
        : "Product or variant not found.",
    );
  }

  const stockAfter = await currentStock(tx, productId, variantId);
  await tx.stockAdjustment.create({
    data: {
      productId, variantId, delta, stockAfter, reason: args.reason, createdById: args.adminId,
      kind: args.kind ?? "MANUAL_ADJUSTMENT", sourceType: args.sourceType ?? null, sourceId: args.sourceId ?? null, idempotencyKey: key,
    },
  });
  return stockAfter;
}

async function currentStock(tx: Prisma.TransactionClient, productId: string, variantId: string | null): Promise<number> {
  const current = variantId
    ? await tx.productVariant.findUnique({ where: { id: variantId }, select: { stock: true } })
    : await tx.product.findUnique({ where: { id: productId }, select: { stock: true } });
  return current?.stock ?? 0;
}

/**
 * Writes a ledger row for a movement that was ALREADY executed by a guarded update elsewhere (order placement/release), without
 * touching stock again. Idempotent by key. `stockAfter` is the SKU's stock when the row is written.
 */
export async function recordMovementRow(
  tx: Prisma.TransactionClient,
  args: Target & Required<Pick<MovementMeta, "kind" | "sourceType" | "sourceId">> & { delta: number; reason: string; adminId?: string | null; idempotencyKey: string },
): Promise<void> {
  const prior = await tx.stockAdjustment.findUnique({ where: { idempotencyKey: args.idempotencyKey }, select: { id: true } });
  if (prior) return;
  await tx.stockAdjustment.create({
    data: {
      productId: args.productId, variantId: args.variantId, delta: args.delta, stockAfter: await currentStock(tx, args.productId, args.variantId),
      reason: args.reason, createdById: args.adminId ?? null, kind: args.kind, sourceType: args.sourceType, sourceId: args.sourceId, idempotencyKey: args.idempotencyKey,
    },
  });
}

export async function adjustStock(input: {
  productId: string;
  variantId?: string | null;
  delta: number;
  reason: string;
  adminId: string | null;
  /** One key per form submission: a retry/double-click returns the first result instead of adjusting twice. */
  idempotencyKey?: string | null;
}) {
  await assertAdminActor(prisma, input.adminId);
  const valid = validateAdjustment({ delta: input.delta, reason: input.reason });
  if (!valid.ok) throw new UserFacingError(valid.message);

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: { id: true, type: true },
    });
    if (!product) throw new UserFacingError("Product not found.");

    const variantId = input.variantId ?? null;
    if (product.type === "VARIANT") {
      if (!variantId) throw new UserFacingError("Choose which variant to adjust.");
      // Ownership: the variant must belong to THIS product.
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, productId: product.id },
        select: { id: true },
      });
      if (!variant) throw new UserFacingError("Variant not found for this product.");
    } else if (variantId) {
      throw new UserFacingError("This product has no variants.");
    }

    const stockAfter = await applyStockDelta(tx, {
      productId: product.id,
      variantId,
      delta: valid.delta,
      reason: valid.reason,
      adminId: input.adminId,
      kind: "MANUAL_ADJUSTMENT",
      sourceType: "ADMIN",
      sourceId: input.adminId ?? undefined,
      idempotencyKey: input.idempotencyKey ? `ADJ:${input.idempotencyKey}` : null,
    });
    return { stockAfter };
  });
}

export async function listStockAdjustments(productId: string, limit = 20) {
  return prisma.stockAdjustment.findMany({
    where: { productId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    include: { variant: { select: { name: true } } },
  });
}
