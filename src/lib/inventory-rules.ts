/**
 * Stock-movement rules (pure, unit-tested). The ONE place that defines how many units of an order line are physically out,
 * how many may still come back, and what a cancel/refund may release. Services only execute these decisions inside a
 * transaction with guarded updates.
 *
 * ## Per-line accounting (units of ONE SKU; for a COMPONENTS-policy combo line the counters count whole combos)
 *   out        = stockDeducted + procurementReceivedQty   units that physically left sellable stock for this order
 *                (units received from a supplier are reserved for the order, they never entered sellable stock)
 *   returned   = stockReturnedQty                         went back on the shelf (sellable)
 *   discarded  = stockDiscardedQty                        came back (or stayed) UNSELLABLE: out of stock for good
 *   remaining  = out − returned − discarded               still with the customer / courier: the only units that may still be restocked or discarded
 *   INVARIANT  returned + discarded ≤ out   (database CHECK as a backstop)
 *
 * ## What puts units back — and nothing else does
 *   1. Order cancelled/refunded BEFORE the goods left (PENDING, CONFIRMED, PROCESSING → CANCELLED): everything still `remaining` returns (mode FULL).
 *   2. A RESTOCK incident that says the returned units are SELLABLE (capped by `remaining`).
 *   Goods that already shipped (FAILED_DELIVERY→CANCELLED, DELIVERED→REFUNDED) are NOT assumed to be back or sellable: the order-status change only
 *   releases units that never existed (outstanding procurement); the physical goods are restocked/discarded by incidents (mode PENDING_ONLY).
 *   Units never physically taken (untracked products, units still awaiting a supplier) can never be restocked.
 */
import type { OrderStatusName } from "@/lib/order-transitions";

export type LineCounters = {
  quantity: number;
  stockDeducted: number;
  procurementQty: number;
  procurementReceivedQty: number;
  stockReturnedQty: number;
  stockDiscardedQty: number;
  /** True for a combo line whose stock comes from its COMPONENTS (the line itself moves no stock; counters are in whole combos). */
  componentPolicy?: boolean;
};

/** Units that physically left sellable stock for this line (whole combos for a COMPONENTS-policy line). */
export function physicalOut(l: LineCounters): number {
  return l.componentPolicy ? l.quantity : l.stockDeducted + l.procurementReceivedQty;
}

/** Units still out (with customer/courier) that an incident may restock or discard. Never negative. */
export function remainingOut(l: LineCounters): number {
  return Math.max(physicalOut(l) - l.stockReturnedQty - l.stockDiscardedQty, 0);
}

/** Units accepted beyond stock that have not arrived yet (they never existed physically). */
export function outstandingProcurement(l: Pick<LineCounters, "procurementQty" | "procurementReceivedQty">): number {
  return Math.max(l.procurementQty - l.procurementReceivedQty, 0);
}

export type ReleaseMode = "FULL" | "PENDING_ONLY";

/** Statuses from which the goods have not left the building: a cancel returns them automatically. */
const NOT_YET_SHIPPED: readonly OrderStatusName[] = ["PENDING", "CONFIRMED", "PROCESSING"];

export function releaseModeFor(from: OrderStatusName): ReleaseMode {
  return NOT_YET_SHIPPED.includes(from) ? "FULL" : "PENDING_ONLY";
}

/** What leaving the stock-holding lifecycle (cancel/refund) does to ONE line. */
export function planRelease(l: LineCounters, mode: ReleaseMode): { backToShelf: number; releasePending: number } {
  return { backToShelf: mode === "FULL" ? remainingOut(l) : 0, releasePending: outstandingProcurement(l) };
}

/** Order statuses in which goods have left and can therefore come back through an incident. */
export function goodsCanComeBack(status: OrderStatusName): boolean {
  return !NOT_YET_SHIPPED.includes(status);
}

export type StockEffect = "NONE" | "RESTOCK" | "WRITE_OFF" | "DISCARD";

/** Validates an incident's effect on one order line. Returns an error message or null. */
export function checkLineStockEffect(effect: StockEffect, qty: number, line: LineCounters, orderStatus: OrderStatusName): string | null {
  if (effect !== "RESTOCK" && effect !== "DISCARD") return null;
  if (!goodsCanComeBack(orderStatus)) return "The goods of this order have not left yet. Cancel the order to return them to stock.";
  if (physicalOut(line) <= 0) return "This line never took units from sellable stock (untracked product, or units not yet received), so there is nothing to put back. Use a stock adjustment if you really have extra units.";
  const remaining = remainingOut(line);
  if (qty > remaining) {
    return remaining <= 0
      ? "All units of this line are already back in stock or marked unsellable."
      : `Only ${remaining} unit${remaining === 1 ? "" : "s"} of this line can still be ${effect === "RESTOCK" ? "put back" : "marked unsellable"}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Legacy backorder reconciliation (pure planner; the service executes it only when an admin applies it)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * BEFORE migration 20261105000000 a backordered unit was deducted from stock WITHOUT a floor (stock went negative) and the order
 * line recorded `stockDeducted = quantity`. That migration floored stock at 0 and moved the debt into `procurementPending`, but
 * the order lines still say "all deducted". Result: pending debt that no order line owns (it can never be allocated or released)
 * and lines that would give back units that never existed if cancelled.
 *
 * RULE (documented, deterministic, reversible by reading the audit rows): for each SKU, `unlinked = procurementPending − Σ outstanding
 * procurement of open lines`. Move that many units from `stockDeducted` to `procurementQty` on the NEWEST open, not-yet-shipped lines
 * of that SKU first (the newest orders are the ones placed after stock ran out). Stock quantities and procurementPending are NOT changed.
 * Shipped/delivered orders are never touched; any remainder is reported for a manual decision.
 */
export type LegacyCandidate = { lineId: string; orderCreatedAt: number; stockDeducted: number };
export type LegacyLink = { lineId: string; moveUnits: number; stockDeductedBefore: number; stockDeductedAfter: number };

export function planLegacyBackorderLink(unlinked: number, candidates: readonly LegacyCandidate[]): { links: LegacyLink[]; residual: number } {
  let left = Math.max(Math.trunc(unlinked), 0);
  const links: LegacyLink[] = [];
  for (const c of [...candidates].sort((a, b) => b.orderCreatedAt - a.orderCreatedAt || (a.lineId < b.lineId ? 1 : -1))) {
    if (left <= 0) break;
    const move = Math.min(c.stockDeducted, left);
    if (move <= 0) continue;
    links.push({ lineId: c.lineId, moveUnits: move, stockDeductedBefore: c.stockDeducted, stockDeductedAfter: c.stockDeducted - move });
    left -= move;
  }
  return { links, residual: left };
}
