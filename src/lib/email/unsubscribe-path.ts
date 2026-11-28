/**
 * Where the public unsubscribe endpoint lives (Prompt 11). PURE and dependency-free on purpose: it is imported by the route handler, by the URL
 * builder and by `instrumentation.ts` (which may be bundled for more than one runtime), so it must not import `node:crypto` or anything server-only.
 *
 * The route is under /api/ deliberately: /api/ is already excluded from the redirect proxy (src/proxy.ts matcher) and is already `Disallow`ed in
 * robots.txt (PRIVATE_PATHS), so neither an admin-managed redirect nor a crawler ever sees an unsubscribe link.
 */
export const UNSUBSCRIBE_ROUTE_PREFIX = "/api/email/unsubscribe/";

/** 32 bytes (HMAC-SHA256 output), base64url, no padding. Identical to the shape `hashUnsubscribeToken` (P07) already accepts. */
export const UNSUBSCRIBE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const isWellFormedUnsubscribeToken = (value: unknown): value is string => typeof value === "string" && UNSUBSCRIBE_TOKEN_PATTERN.test(value);

/**
 * A request path with the token removed, for logs. The token is the last path segment of the unsubscribe route; Next.js's `onRequestError` would
 * otherwise write it to the server log if a handler ever threw. Any other path is returned unchanged.
 */
export function redactUnsubscribePath(path: string): string {
  return typeof path === "string" && path.startsWith(UNSUBSCRIBE_ROUTE_PREFIX) ? `${UNSUBSCRIBE_ROUTE_PREFIX}[redacted]` : path;
}

/** Is `path` exactly the unsubscribe route followed by one well-formed token (nothing before, nothing after)? */
export function isUnsubscribeRoutePath(path: unknown): boolean {
  return typeof path === "string" && path.startsWith(UNSUBSCRIBE_ROUTE_PREFIX) && isWellFormedUnsubscribeToken(path.slice(UNSUBSCRIBE_ROUTE_PREFIX.length));
}
