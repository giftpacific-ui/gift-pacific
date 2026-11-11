import type { OrderStatus } from "@prisma/client";

/**
 * "Buy again" is offered once the order has reached an end state. Open orders are excluded so a customer is not
 * nudged to duplicate something still on its way.
 */
export const REORDER_ELIGIBLE_STATUSES: readonly OrderStatus[] = ["DELIVERED", "CANCELLED", "FAILED_DELIVERY", "REFUNDED"];

export const canBuyAgain = (status: string): boolean => (REORDER_ELIGIBLE_STATUSES as readonly string[]).includes(status);
