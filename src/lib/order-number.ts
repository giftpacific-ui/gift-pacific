/**
 * Human-readable, collision-safe order numbers.
 *
 * Format: AP-YYYYMM-NNNNNN   e.g. AP-202610-000123
 *
 * Uniqueness comes from a PostgreSQL SEQUENCE (`order_number_seq`, created in
 * the initial migration) — `nextval()` is atomic and never returns the same
 * value to two concurrent callers, with no row/table locking and no
 * read-then-write race. The date prefix is cosmetic only; the sequence value
 * alone guarantees uniqueness, and `Order.orderNumber @unique` stays as a
 * last-line backstop.
 *
 * The previous `count(orders today) + 1` approach was a classic race: two
 * concurrent checkouts read the same count and produced the same number.
 */

export const ORDER_NUMBER_PREFIX = "AP";
export const ORDER_NUMBER_SEQUENCE = "order_number_seq";

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // Bangladesh: UTC+6, no DST

export function formatOrderNumber(now: Date, sequence: bigint | number): string {
  const local = new Date(now.getTime() + DHAKA_OFFSET_MS);
  const yyyymm = `${local.getUTCFullYear()}${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
  const seq = typeof sequence === "bigint" ? sequence.toString() : String(Math.trunc(sequence));
  if (!/^[1-9]\d*$/.test(seq)) throw new Error("Order sequence must be a positive integer.");
  return `${ORDER_NUMBER_PREFIX}-${yyyymm}-${seq.padStart(6, "0")}`;
}

/** `nextSequence` is the DB's atomic `nextval` — injected so the formatting/flow is testable. */
export async function generateOrderNumber(
  nextSequence: () => Promise<bigint | number>,
  now: Date = new Date(),
): Promise<string> {
  return formatOrderNumber(now, await nextSequence());
}
