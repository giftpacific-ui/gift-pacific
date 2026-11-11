/**
 * The order-confirmation token (which lets a GUEST view their order) used to
 * be put in the URL (`?token=…`), where it leaked into browser history,
 * Referer headers and analytics page-view URLs. It now lives in a short-lived
 * httpOnly cookie scoped to the confirmation pages; the URL carries only the
 * order number. Pure encode/decode here; cookie I/O is in server/confirmation.ts.
 */
export const CONFIRMATION_COOKIE = "giftpacific_order_conf";
/**
 * Cookie name used before the Gift Pacific rebrand. It is only READ (never written) so a guest who placed an order just before
 * the deploy can still open their confirmation page during the cookie's 24-hour life. Allow-listed legacy reference.
 */
// branding-guard:allow (documented legacy compatibility, see HANDOFF_GIFTPACIFIC.md)
export const LEGACY_CONFIRMATION_COOKIE = "ap_order_conf";
export const CONFIRMATION_COOKIE_PATH = "/checkout/confirmation";
export const CONFIRMATION_MAX_AGE_SECONDS = 60 * 60 * 24;

const ORDER_NUMBER = /^AP-[A-Za-z0-9-]{3,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export function encodeConfirmation(orderNumber: string, token: string): string | null {
  return ORDER_NUMBER.test(orderNumber) && TOKEN.test(token) ? `${orderNumber}.${token}` : null;
}

/** Returns the token only if the cookie was issued for exactly this order. */
export function tokenForOrder(cookieValue: string | undefined | null, orderNumber: string): string | undefined {
  if (!cookieValue) return undefined;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const number = cookieValue.slice(0, dot);
  const token = cookieValue.slice(dot + 1);
  return number === orderNumber && ORDER_NUMBER.test(number) && TOKEN.test(token) ? token : undefined;
}
