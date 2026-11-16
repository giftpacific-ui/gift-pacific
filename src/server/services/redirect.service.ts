import { prisma } from "@/lib/db/prisma";
import { resolveRedirect } from "@/lib/redirect-rules";

/**
 * Active admin redirects for the proxy. The table is small, so ONE query loads it and the result is held in memory for a
 * short TTL: the proxy never queries the database per request. Admin saves call clearRedirectCache() (this instance applies
 * the change immediately; other instances pick it up within the TTL). Any failure fails OPEN (no redirect, page still served).
 */
const TTL_MS = 30_000;
let cache: { at: number; map: Map<string, { to: string; status: number }> } | null = null;

export function clearRedirectCache() {
  cache = null;
}

async function loadMap() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const rows = await prisma.redirect.findMany({ where: { isActive: true }, select: { fromPath: true, toPath: true, statusCode: true } });
  const map = new Map(rows.map((r) => [r.fromPath, { to: r.toPath, status: r.statusCode }]));
  cache = { at: Date.now(), map };
  return map;
}

export async function findActiveRedirect(path: string): Promise<{ to: string; status: 301 | 302 } | null> {
  try {
    const hit = resolveRedirect(path, await loadMap());
    return hit ? { to: hit.to, status: hit.status === 302 ? 302 : 301 } : null;
  } catch {
    return null;
  }
}
