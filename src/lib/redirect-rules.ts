/** Pure redirect validation: path normalisation, safe destinations (no open redirects) and loop detection. */

export type RedirectCheck<T> = { ok: true; value: T } | { ok: false; error: string };

export const REDIRECT_STATUS_CODES = [301, 302] as const;
export type RedirectStatus = (typeof REDIRECT_STATUS_CODES)[number];

/** A redirect may never originate from these areas (admin, API, assets, auth/account/checkout, the root). */
const PROTECTED_SOURCES = ["/admin", "/api", "/_next", "/account", "/checkout", "/cart", "/login", "/register", "/sitemap", "/robots.txt", "/sitemap.xml", "/favicon.ico"];

export function normalizeRedirectPath(input: string): string {
  const p = input.trim().split("#")[0].split("?")[0].replace(/\/{2,}/g, "/");
  const withSlash = p.startsWith("/") ? p : `/${p}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

export function validateRedirectSource(input: string): RedirectCheck<string> {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter the old path, e.g. /old-page." };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return { ok: false, error: "The old URL must be a path on this site (e.g. /old-page), not a full URL." };
  if (/[\s\u0000-\u001f\\]/.test(raw)) return { ok: false, error: "The old path must not contain spaces or backslashes." };
  if (raw.includes("?") || raw.includes("#")) return { ok: false, error: "Query strings and #fragments are not matched. Enter the path only." };
  const path = normalizeRedirectPath(raw);
  if (path === "/") return { ok: false, error: "The homepage cannot be redirected." };
  if (path.length > 300) return { ok: false, error: "The path is too long." };
  if (PROTECTED_SOURCES.some((s) => path === s || path.startsWith(`${s}/`))) return { ok: false, error: "Admin, API, account, checkout and system paths cannot be redirected." };
  return { ok: true, value: path };
}

/**
 * Destination: a site path (stored as a path) or an absolute URL on THIS site's host (converted to a path).
 * External hosts, protocol-relative URLs, javascript:/data: and credentials are rejected: a redirect manager that
 * accepted them would be an open redirect.
 */
export function validateRedirectDestination(input: string, origin: string): RedirectCheck<string> {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter the new path, e.g. /new-page." };
  if (/[\s\u0000-\u001f]/.test(raw)) return { ok: false, error: "The destination must not contain spaces." };
  if (raw.includes("\\")) return { ok: false, error: "Backslashes are not allowed (browsers treat /\\host like //host)." };
  if (raw.startsWith("//")) return { ok: false, error: "Protocol-relative destinations are not allowed." };
  let path: string;
  let suffix = "";
  if (raw.startsWith("/")) {
    const m = /^([^?#]*)(.*)$/.exec(raw)!;
    path = normalizeRedirectPath(m[1]);
    suffix = m[2];
  } else {
    let u: URL;
    let base: URL;
    try { u = new URL(raw); base = new URL(origin); } catch { return { ok: false, error: "Enter a path such as /new-page or a full URL on this site." }; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Only http(s) destinations on this site are allowed." };
    if (u.username || u.password) return { ok: false, error: "The destination must not contain credentials." };
    if (u.host.toLowerCase() !== base.host.toLowerCase()) return { ok: false, error: `Redirects can only point to ${base.host}. External destinations are not allowed.` };
    path = normalizeRedirectPath(u.pathname);
    suffix = `${u.search}${u.hash}`;
  }
  if (suffix && !/^(\?[^\s]*)?(#[^\s]*)?$/.test(suffix)) return { ok: false, error: "Invalid query string or fragment." };
  if (PROTECTED_SOURCES.filter((s) => s !== "/sitemap" && s !== "/robots.txt" && s !== "/sitemap.xml").some((s) => path === s || path.startsWith(`${s}/`)) && path.startsWith("/api")) {
    return { ok: false, error: "Redirecting to API paths is not allowed." };
  }
  return { ok: true, value: `${path}${suffix}` };
}

/**
 * Follows `map` (from → to, ACTIVE rules only) starting at `candidateTo` after adding from → candidateTo.
 * Returns an error when the chain loops back to a visited path or exceeds `maxHops`.
 */
export function detectRedirectLoop(from: string, to: string, existing: ReadonlyMap<string, string>, maxHops = 10): RedirectCheck<true> {
  const map = new Map(existing);
  map.set(from, to);
  const seen = new Set<string>([from]);
  let current = normalizeRedirectPath(to.split("?")[0].split("#")[0]);
  for (let hop = 0; hop < maxHops; hop++) {
    if (seen.has(current)) return { ok: false, error: `This would create a redirect loop (${[...seen, current].join(" → ")}).` };
    seen.add(current);
    const next = map.get(current);
    if (next === undefined) return { ok: true, value: true };
    current = normalizeRedirectPath(next.split("?")[0].split("#")[0]);
  }
  return { ok: false, error: `The redirect chain is longer than ${maxHops} hops. Point it straight at the final page.` };
}

/** Resolves a request path through the rules (collapsing chains) — used by the proxy. Loops/overlong chains resolve to null. */
export function resolveRedirect(path: string, map: ReadonlyMap<string, { to: string; status: number }>, maxHops = 5): { to: string; status: number } | null {
  let current = normalizeRedirectPath(path);
  const first = map.get(current);
  if (!first) return null;
  let hit = first;
  const seen = new Set([current]);
  for (let i = 0; i < maxHops; i++) {
    const nextPath = normalizeRedirectPath(hit.to.split("?")[0].split("#")[0]);
    const next = map.get(nextPath);
    if (!next) return hit.to.startsWith("/") ? hit : null;
    if (seen.has(nextPath)) return null;
    seen.add(nextPath);
    current = nextPath;
    hit = { to: next.to, status: first.status === 301 && next.status === 301 ? 301 : 302 };
  }
  return null;
}
