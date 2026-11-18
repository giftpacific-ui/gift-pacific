/**
 * The opaque first-party consent reference (cookie `gp_cref`).
 *
 * It is 128 random bits from the browser's CSPRNG, minted when the visitor grants consent. It is NOT derived from an email, phone,
 * order id, user id or anything else, so it identifies nothing by itself: it only lets the server find "the events recorded while THIS
 * browser's consent was granted" when that consent is withdrawn. Possession of the value is the only proof required, which is safe
 * because the single thing it can do is withdraw (fail-closed).
 */
export const CONSENT_REF_COOKIE = "gp_cref";
export const CONSENT_REF_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
/** localStorage key holding a withdrawal that has not been acknowledged by the server yet (retried on the next page load). */
export const PENDING_WITHDRAWAL_KEY = "gp_consent_withdraw_pending";

const REF_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

export const isValidConsentRef = (value: unknown): value is string => typeof value === "string" && REF_PATTERN.test(value);

/** `fill` must write random bytes into the buffer it is given (e.g. crypto.getRandomValues). */
export function generateConsentRef(fill: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(16);
  fill(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
