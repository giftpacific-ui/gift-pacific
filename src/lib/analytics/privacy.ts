/**
 * What analytics may see. Pure helpers (unit-tested) so the rules live in one
 * place instead of being re-implemented inside script snippets.
 *
 *  - Pages that are private or carry secrets (admin, account, login/register,
 *    password reset) never load analytics at all.
 *  - Page views report the PATH only — never the query string or hash, which
 *    can hold search text, tokens or redirect targets.
 */
const UNTRACKED_PREFIXES = ["/admin", "/account", "/login", "/register", "/forgot-password", "/reset-password", "/api"] as const;

export function isTrackablePath(pathname: string | null | undefined): boolean {
  if (!pathname) return true;
  return !UNTRACKED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Path only, with the order number of a confirmation page removed. */
export function analyticsPath(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] || "/";
  return path.replace(/^\/checkout\/confirmation\/[^/]+/, "/checkout/confirmation");
}

/** Dedup: a page view is sent only when the (sanitized) path actually changed. */
export function shouldSendPageView(previous: string | null, next: string): boolean {
  return previous !== next;
}
