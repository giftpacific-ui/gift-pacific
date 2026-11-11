import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { outstandingProcurement, physicalOut, planLegacyBackorderLink, type LegacyLink } from "@/lib/inventory-rules";
import { recordMovementRow } from "@/server/services/stock-adjustment.service";

/**
 * Audit + (optional) repair of data written BEFORE the Phase 2 stock rules. Nothing here runs by itself.
 *
 *  - `previewInventoryReconciliation()` is read-only: it reports what is inconsistent and exactly what "apply" would change.
 *  - `applyLegacyBackorderLinks()` changes ONLY order-line counters (stockDeducted → procurementQty) by the documented rule in
 *    src/lib/inventory-rules.ts (planLegacyBackorderLink). It never changes a stock quantity, never changes procurementPending, and writes one
 *    ledger row per changed line (kind RECONCILE_LEGACY_BACKORDER) so every change is auditable and re-running it is a no-op.
 */

const NOT_SHIPPED = ["PENDING", "CONFIRMED", "PROCESSING"] as const;

export type SkuReport = {
  productId: string; variantId: string | null; name: string;
  stock: number; pending: number; linkedOutstanding: number; unlinked: number;
  links: (LegacyLink & { orderNumber: string })[]; residual: number;
};
export type Anomaly = { lineId: string; orderNumber: string; code: "LEGACY_RELEASE_AND_RESTOCK" | "COMBO_PRODUCT_RESTOCKED" | "COUNTERS_EXCEED_OUT"; detail: string };
export type ReconcileReport = {
  negativeStock: { productId: string; variantId: string | null; name: string; stock: number }[];
  skus: SkuReport[];
  anomalies: Anomaly[];
  totals: { unlinkedUnits: number; plannedUnits: number; residualUnits: number };
};

type Sku = { productId: string; variantId: string | null; name: string; stock: number; pending: number };

async function loadSkus(): Promise<Sku[]> {
  const products = await prisma.product.findMany({
    where: { OR: [{ procurementPending: { gt: 0 } }, { stock: { lt: 0 } }, { variants: { some: { OR: [{ procurementPending: { gt: 0 } }, { stock: { lt: 0 } }] } } }] },
    select: { id: true, name: true, type: true, stock: true, procurementPending: true, variants: { select: { id: true, name: true, stock: true, procurementPending: true } } },
  });
  const out: Sku[] = [];
  for (const p of products) {
    if (p.type !== "VARIANT") out.push({ productId: p.id, variantId: null, name: p.name, stock: p.stock, pending: p.procurementPending });
    for (const v of p.variants) out.push({ productId: p.id, variantId: v.id, name: `${p.name} — ${v.name}`, stock: v.stock, pending: v.procurementPending });
  }
  return out.filter((s) => s.pending > 0 || s.stock < 0);
}

async function planFor(db: Pick<typeof prisma, "orderItem" | "orderItemComponent">, sku: Sku): Promise<SkuReport> {
  const lines = await db.orderItem.findMany({
    where: { productId: sku.productId, variantId: sku.variantId, stockRestoredAt: null },
    select: { id: true, procurementQty: true, procurementReceivedQty: true, stockDeducted: true, order: { select: { orderNumber: true, status: true, createdAt: true } } },
  });
  const comps = await db.orderItemComponent.findMany({
    where: { productId: sku.productId, variantId: sku.variantId, stockRestoredAt: null },
    select: { procurementQty: true, procurementReceivedQty: true },
  });
  const linked = [...lines, ...comps].reduce((s, r) => s + outstandingProcurement(r), 0);
  const unlinked = Math.max(sku.pending - linked, 0);
  const candidates = lines.filter((l) => (NOT_SHIPPED as readonly string[]).includes(l.order.status) && l.procurementQty === 0 && l.stockDeducted > 0);
  const plan = planLegacyBackorderLink(unlinked, candidates.map((l) => ({ lineId: l.id, orderCreatedAt: new Date(l.order.createdAt).getTime(), stockDeducted: l.stockDeducted })));
  const number = new Map<string, string>(lines.map((l) => [l.id, String(l.order.orderNumber)] as [string, string]));
  return { ...sku, linkedOutstanding: linked, unlinked, links: plan.links.map((l) => ({ ...l, orderNumber: number.get(l.lineId) ?? "?" })), residual: plan.residual };
}

export async function previewInventoryReconciliation(): Promise<ReconcileReport> {
  const skus = await loadSkus();
  const reports: SkuReport[] = [];
  for (const sku of skus) if (sku.pending > 0) reports.push(await planFor(prisma, sku));

  // Anomalies in line counters / history
  const anomalies: Anomaly[] = [];
  const incidents = await prisma.financialIncident.findMany({ where: { stockEffect: "RESTOCK", orderItemId: { not: null } }, select: { orderItemId: true, quantity: true, productId: true } });
  const lineIds = [...new Set(incidents.map((i) => i.orderItemId!).filter(Boolean))];
  if (lineIds.length) {
    const lines = await prisma.orderItem.findMany({
      where: { id: { in: lineIds } },
      select: { id: true, productId: true, stockRestoredAt: true, order: { select: { orderNumber: true } }, components: { select: { id: true, stockDeducted: true } } },
    });
    const releaseRows = await prisma.stockAdjustment.findMany({ where: { sourceType: "ORDER_ITEM", kind: "ORDER_RELEASED", sourceId: { in: lineIds } }, select: { sourceId: true } });
    const releasedByLedger = new Set(releaseRows.map((r) => r.sourceId));
    for (const l of lines) {
      const restocked = incidents.filter((i) => i.orderItemId === l.id).reduce((s, i) => s + i.quantity, 0);
      if (l.stockRestoredAt && !releasedByLedger.has(l.id)) anomalies.push({ lineId: l.id, orderNumber: l.order.orderNumber, code: "LEGACY_RELEASE_AND_RESTOCK", detail: `Released by a cancel/refund before the ledger existed AND restocked by incident(s) (${restocked} unit${restocked === 1 ? "" : "s"}): stock may be overstated by up to ${restocked}. Verify with a physical count.` });
      if (l.components.some((c) => c.stockDeducted > 0)) anomalies.push({ lineId: l.id, orderNumber: l.order.orderNumber, code: "COMBO_PRODUCT_RESTOCKED", detail: `Restock incident recorded on a combo whose stock came from its components: the combo product itself may have received ${restocked} phantom unit${restocked === 1 ? "" : "s"}. Verify with a physical count.` });
    }
  }
  const counted = await prisma.orderItem.findMany({
    where: { OR: [{ stockReturnedQty: { gt: 0 } }, { stockDiscardedQty: { gt: 0 } }] },
    select: { id: true, quantity: true, stockDeducted: true, procurementQty: true, procurementReceivedQty: true, stockReturnedQty: true, stockDiscardedQty: true, order: { select: { orderNumber: true } }, components: { select: { stockDeducted: true, procurementQty: true } } },
  });
  for (const l of counted) {
    const componentPolicy = l.components.some((c) => c.stockDeducted > 0 || c.procurementQty > 0);
    const out = physicalOut({ ...l, componentPolicy });
    if (l.stockReturnedQty + l.stockDiscardedQty > out) anomalies.push({ lineId: l.id, orderNumber: l.order.orderNumber, code: "COUNTERS_EXCEED_OUT", detail: `Returned ${l.stockReturnedQty} + unsellable ${l.stockDiscardedQty} is more than the ${out} unit(s) that left stock.` });
  }

  return {
    negativeStock: skus.filter((s) => s.stock < 0).map((s) => ({ productId: s.productId, variantId: s.variantId, name: s.name, stock: s.stock })),
    skus: reports.filter((r) => r.unlinked > 0),
    anomalies,
    totals: {
      unlinkedUnits: reports.reduce((s, r) => s + r.unlinked, 0),
      plannedUnits: reports.reduce((s, r) => s + r.links.reduce((a, l) => a + l.moveUnits, 0), 0),
      residualUnits: reports.reduce((s, r) => s + r.residual, 0),
    },
  };
}

/**
 * Applies the planned links. `expectedUnits` (from the preview the admin looked at) must still match, otherwise nothing is changed:
 * the data moved since the preview and the admin has to look again.
 */
export async function applyLegacyBackorderLinks(adminId: string | null, expectedUnits: number): Promise<{ linkedLines: number; units: number }> {
  return prisma.$transaction(async (tx) => {
    const skus = (await loadSkus()).filter((s) => s.pending > 0);
    const plans: SkuReport[] = [];
    for (const sku of skus) plans.push(await planFor(tx as never, sku));
    const planned = plans.reduce((s, p) => s + p.links.reduce((a, l) => a + l.moveUnits, 0), 0);
    if (planned !== expectedUnits) throw new UserFacingError(`The data changed since the preview (now ${planned} unit(s) to link, you reviewed ${expectedUnits}). Reload the preview and review it again.`);
    let linkedLines = 0, units = 0;
    for (const plan of plans) {
      for (const link of plan.links) {
        const done = await tx.orderItem.updateMany({
          where: { id: link.lineId, stockRestoredAt: null, procurementQty: 0, stockDeducted: link.stockDeductedBefore },
          data: { stockDeducted: link.stockDeductedAfter, procurementQty: link.moveUnits },
        });
        if (done.count !== 1) continue; // changed meanwhile (cancelled, shipped-and-released…): leave it
        await recordMovementRow(tx, {
          productId: plan.productId, variantId: plan.variantId, delta: 0, kind: "RECONCILE_LEGACY_BACKORDER", sourceType: "ORDER_ITEM", sourceId: link.lineId, adminId,
          reason: `Legacy backorder linked to order ${link.orderNumber}: ${link.moveUnits} of ${link.stockDeductedBefore} deducted unit(s) were never in stock; line now awaits ${link.moveUnits} from procurement (stock and pending unchanged).`,
          idempotencyKey: `RECONCILE:${link.lineId}`,
        });
        linkedLines += 1; units += link.moveUnits;
      }
    }
    return { linkedLines, units };
  });
}
