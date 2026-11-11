/**
 * Columns that must NEVER reach a customer-facing projection. One list, used by every customer order query/mapper, so a column added
 * here cannot leak through one forgotten place (the account dashboard once did).
 */
export const ORDER_INTERNAL_FIELDS = [
  // our advance/fraud scoring, staff waiver/review decisions
  "trustScore", "trustSnapshot", "advanceWaivedById", "advanceWaivedReason", "advanceWaivedAt",
  "trustReviewRequired", "trustReviewedById", "trustReviewedAt", "trustReviewNote",
  // third-party / settlement bookkeeping
  "settlementStatus", "settledAt", "externalOrderRef", "externalPlacedAt",
] as const;

/** Order-line columns that are never customer-visible: our cost and every stock/procurement counter. */
export const ITEM_INTERNAL_FIELDS = [
  "stockDeducted", "stockRestoredAt", "stockReturnedQty", "stockDiscardedQty", "procurementQty", "procurementReceivedQty", "unitCost", "comboSnapshot",
] as const;

/** Prisma `omit` object for a list of column names. */
export const omitFields = <T extends string>(fields: readonly T[]): Record<T, true> => Object.fromEntries(fields.map((f) => [f, true])) as Record<T, true>;
