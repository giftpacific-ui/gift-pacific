/**
 * Money helpers shared by accounting, reports and settlement code.
 *
 * Amounts are stored as Decimal(10,2) in PostgreSQL and read as JS numbers at the edge. EVERY sum is done in whole
 * paisa (integers) and only converted back for display/serialisation, so totals can never drift by floating-point error.
 */
export const toPaisa = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100);
export const fromPaisa = (p: number): number => p / 100;

/** True when `n` is a finite amount with at most 2 decimal places, within [min, max]. */
export function isMoneyAmount(n: unknown, opts: { min?: number; max?: number } = {}): n is number {
  const { min = 0, max = 100_000_000 } = opts;
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max && toPaisa(n) / 100 === n;
}
