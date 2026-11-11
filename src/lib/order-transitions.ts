import { UserFacingError } from "@/lib/errors";

/**
 * Explicit order-status transition policy + the inventory lifecycle that
 * hangs off it.
 *
 * ## Policy
 * Forward fulfilment moves one step at a time; CANCELLED is only reachable
 * before the parcel ships; refunds only follow DELIVERED. CANCELLED and
 * REFUNDED are TERMINAL: nothing leaves them, so an order can never be
 * "un-cancelled" or "un-refunded" (the old code allowed any status → any
 * status and re-consumed stock when reversing).
 *
 * ## Inventory lifecycle (deterministic)
 *  1. PLACE   — stock is deducted once, inside the order transaction, and the
 *               amount actually deducted is recorded on the OrderItem
 *               (`stockDeducted`). Untracked items record 0.
 *  2. RELEASE — on entering CANCELLED or REFUNDED (each terminal ⇒ at most one
 *               release per order) exactly `stockDeducted` is added back, and
 *               `stockRestoredAt` is set. A guarded UPDATE (…WHERE
 *               stockRestoredAt IS NULL) makes the restore idempotent even
 *               under concurrent requests.
 *  3. NOTHING ELSE touches stock. There is no "consume again" path.
 */

export type OrderStatusName =
  | "PENDING"
  | "CONFIRMED"
  | "PROCESSING"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED"
  | "FAILED_DELIVERY"
  | "REFUND_REQUESTED"
  | "REFUNDED";

export const ORDER_STATUSES: readonly OrderStatusName[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "FAILED_DELIVERY",
  "REFUND_REQUESTED",
  "REFUNDED",
];

export const ORDER_STATUS_TRANSITIONS: Record<OrderStatusName, readonly OrderStatusName[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["OUT_FOR_DELIVERY", "DELIVERED", "FAILED_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED_DELIVERY"],
  // A failed delivery may be re-attempted, or the order given up on
  // (CANCELLED), which is what returns the stock to inventory.
  FAILED_DELIVERY: ["OUT_FOR_DELIVERY", "CANCELLED"],
  DELIVERED: ["REFUND_REQUESTED"],
  // Approve → REFUNDED; reject → back to DELIVERED.
  REFUND_REQUESTED: ["REFUNDED", "DELIVERED"],
  CANCELLED: [],
  REFUNDED: [],
};

export class InvalidOrderTransitionError extends UserFacingError {
  constructor(
    public readonly from: OrderStatusName,
    public readonly to: OrderStatusName,
  ) {
    super(`An order can't move from ${from} to ${to}.`);
    this.name = "InvalidOrderTransitionError";
  }
}

export function isOrderStatus(value: unknown): value is OrderStatusName {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: OrderStatusName, to: OrderStatusName): boolean {
  return ORDER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function allowedNextStatuses(from: OrderStatusName): readonly OrderStatusName[] {
  return ORDER_STATUS_TRANSITIONS[from] ?? [];
}

export function assertTransition(from: OrderStatusName, to: OrderStatusName): void {
  if (!canTransition(from, to)) throw new InvalidOrderTransitionError(from, to);
}

export function isTerminalStatus(status: OrderStatusName): boolean {
  return allowedNextStatuses(status).length === 0;
}

/** Statuses that return the order's stock to inventory. Both are terminal. */
export const STOCK_RELEASING_STATUSES: readonly OrderStatusName[] = ["CANCELLED", "REFUNDED"];

export function shouldReleaseStock(from: OrderStatusName, to: OrderStatusName): boolean {
  return !STOCK_RELEASING_STATUSES.includes(from) && STOCK_RELEASING_STATUSES.includes(to);
}

// ---------------------------------------------------------------------------
// Stock deduction planning (placement)
// ---------------------------------------------------------------------------

export type DeductionLine = {
  trackInventory: boolean;
  allowBackorder: boolean;
  quantity: number;
};

/**
 * How a line must be deducted at placement:
 *  - "skip"        untracked → never touched, records stockDeducted = 0
 *  - "guarded"     tracked, no backorder → atomic `stock >= quantity` check
 *  - "backorder"   tracked + backorder explicitly allowed → deduct without
 *                  a floor (negative stock = units owed, by design)
 */
export function deductionMode(line: DeductionLine): "skip" | "guarded" | "backorder" {
  if (!line.trackInventory) return "skip";
  return line.allowBackorder ? "backorder" : "guarded";
}
