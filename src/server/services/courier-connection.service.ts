import "server-only";
import { prisma } from "@/lib/db/prisma";
import { logServerWarning } from "@/lib/logger";
import { sanitizeProviderMessage } from "@/lib/courier/status";
import type { StoredConnectionCheck } from "@/lib/courier/provider-state";

/**
 * Evidence store for "is this courier really connected?". One row per courier holding the newest REAL read-only credential check.
 * Nothing but an actual check ever writes here, so "connected" can never be produced from configuration alone.
 */

export type RecordedCheck = { ok: true } | { ok: false; kind: "auth" | "unreachable" | "unexpected"; message: string };

/**
 * Stores the outcome of a real check. Best effort by design: a failure to store is logged and swallowed, because the check itself already
 * happened and must still be reported to the admin; the only consequence is that the state stays "configured" (not proven).
 */
export async function recordConnectionCheck(args: {
  provider: string;
  fingerprint: string;
  result: RecordedCheck;
  secrets: (string | null | undefined)[];
  checkedById: string | null;
  now: Date;
}): Promise<void> {
  try {
    const previous = await prisma.courierConnectionCheck.findUnique({ where: { provider: args.provider }, select: { lastSuccessAt: true, fingerprint: true } });
    // A success under OTHER credentials says nothing about these ones, so it is not carried over.
    const carried = previous && previous.fingerprint === args.fingerprint ? previous.lastSuccessAt : null;
    const data = {
      ok: args.result.ok,
      failureKind: args.result.ok ? null : args.result.kind,
      message: args.result.ok ? null : sanitizeProviderMessage(args.result.message, args.secrets),
      fingerprint: args.fingerprint,
      lastSuccessAt: args.result.ok ? args.now : carried,
      checkedAt: args.now,
      checkedById: args.checkedById,
    };
    await prisma.courierConnectionCheck.upsert({ where: { provider: args.provider }, create: { provider: args.provider, ...data }, update: data });
  } catch (error) {
    logServerWarning("courier.connection-check.store", error instanceof Error ? error.message : "error", { provider: args.provider });
  }
}

/** Newest stored check per courier. Never throws: when the store cannot be read, nothing can be proven and every courier reads as unverified. */
export async function getStoredConnectionChecks(): Promise<Map<string, StoredConnectionCheck>> {
  try {
    const rows = await prisma.courierConnectionCheck.findMany({});
    return new Map(rows.map((r) => [r.provider, { ok: r.ok, failureKind: r.failureKind, message: r.message, fingerprint: r.fingerprint, lastSuccessAt: r.lastSuccessAt, checkedAt: r.checkedAt }]));
  } catch (error) {
    logServerWarning("courier.connection-check.read", error instanceof Error ? error.message : "error", {});
    return new Map();
  }
}
