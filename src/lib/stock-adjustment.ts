/** Pure validation for manual stock adjustments. */
export const MAX_ADJUSTMENT = 100_000;
export const REASON_MIN = 3;
export const REASON_MAX = 200;

export function validateAdjustment(input: { delta: unknown; reason: unknown }): { ok: true; delta: number; reason: string } | { ok: false; message: string } {
  const { delta } = input;
  if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ADJUSTMENT) {
    return { ok: false, message: `Enter a whole number other than 0 (up to ±${MAX_ADJUSTMENT.toLocaleString()}).` };
  }
  const reason = typeof input.reason === "string" ? input.reason.replace(/\s+/g, " ").trim() : "";
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return { ok: false, message: `Give a short reason (${REASON_MIN}–${REASON_MAX} characters).` };
  }
  return { ok: true, delta, reason };
}
