import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { normalizeIdentifier } from "@/lib/fraud/identity";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";

/**
 * Admin-managed block list and allow list (phone, e-mail, IP).
 *
 *  - Matching is on the NORMALISED value (`normalizeIdentifier`), so "+880 1711-000000" blocks "01711000000" too. Exact match only: there are no
 *    ranges or wildcards (a /24 block would sweep up many legitimate customers on a shared network).
 *  - A reason is mandatory; the admin and time are recorded; entries can expire and be disabled, and are NEVER deleted (history stays complete).
 *    Every change is written to AdminAuditEvent.
 *  - IP blocks are deliberately conservative: they must expire (at most 90 days). Shared networks are common, so an IP block is only ever a prompt
 *    for review, never an automatic rejection (see lib/fraud/scoring.ts).
 *  - Nothing here creates an entry automatically: only a named admin can.
 *  - An allow-list entry only lowers the fraud score. It cannot offset a block and has no effect on advance verification or the low-trust review.
 */
type Db = typeof prisma;
export type RiskListKindName = "PHONE" | "EMAIL" | "IP";
export type RiskListTypeName = "BLOCK" | "ALLOW";

export const MIN_LIST_REASON = 5;
export const MAX_IP_BLOCK_DAYS = 90;
const MAX_EXPIRY_DAYS = 365 * 5;

export type ListMatch = {
  blocked: { phone: boolean; email: boolean; ip: boolean };
  allowed: { phone: boolean; email: boolean; ip: boolean };
  entryIds: string[];
};

const activeWhere = (now: Date) => ({ disabledAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

/** Which ACTIVE (not disabled, not expired) list entries match these normalised identifiers. */
export async function matchRiskLists(
  input: { phones: string[]; email: string | null; ip: string | null },
  opts: { now?: Date; db?: Db } = {},
): Promise<ListMatch> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  // Defensive: callers normally pass normalised values, but matching must never depend on that (normalisation is idempotent).
  const phones = [...new Set(input.phones.map((p) => normalizeIdentifier("PHONE", p)).filter((p): p is string => Boolean(p)))];
  const email = input.email ? normalizeIdentifier("EMAIL", input.email) : null;
  const ip = input.ip ? normalizeIdentifier("IP", input.ip) : null;
  const or: Record<string, unknown>[] = [];
  if (phones.length) or.push({ kind: "PHONE", value: { in: phones } });
  if (email) or.push({ kind: "EMAIL", value: email });
  if (ip) or.push({ kind: "IP", value: ip });
  const out: ListMatch = { blocked: { phone: false, email: false, ip: false }, allowed: { phone: false, email: false, ip: false }, entryIds: [] };
  if (or.length === 0) return out;
  const rows = await db.riskListEntry.findMany({ where: { AND: [activeWhere(now), { OR: or }] }, select: { id: true, listType: true, kind: true } });
  for (const r of rows) {
    const key = r.kind === "PHONE" ? "phone" : r.kind === "EMAIL" ? "email" : "ip";
    (r.listType === "BLOCK" ? out.blocked : out.allowed)[key] = true;
    out.entryIds.push(r.id);
  }
  return out;
}

export type AddRiskListInput = { listType: RiskListTypeName; kind: RiskListKindName; value: string; reason: string; expiresAt?: Date | null; adminId: string };

export async function addRiskListEntry(input: AddRiskListInput, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const kind = input.kind;
  const listType = input.listType;
  if (!["PHONE", "EMAIL", "IP"].includes(kind) || !["BLOCK", "ALLOW"].includes(listType)) throw new UserFacingError("Invalid list entry.");
  const reason = String(input.reason ?? "").trim();
  if (reason.length < MIN_LIST_REASON) throw new UserFacingError(`Give a reason (at least ${MIN_LIST_REASON} characters).`);
  if (reason.length > 300) throw new UserFacingError("The reason is too long (max 300 characters).");
  const raw = String(input.value ?? "").trim();
  const value = normalizeIdentifier(kind, raw);
  if (!value) throw new UserFacingError(kind === "PHONE" ? "Enter a valid Bangladesh mobile number." : kind === "EMAIL" ? "Enter a valid e-mail address." : "Enter a valid IP address.");
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) throw new UserFacingError("The expiry date must be in the future.");
    if (expiresAt.getTime() - now.getTime() > MAX_EXPIRY_DAYS * 86_400_000) throw new UserFacingError("The expiry date is too far away.");
  }
  if (kind === "IP" && listType === "BLOCK") {
    if (!expiresAt) throw new UserFacingError(`IP blocks must expire (at most ${MAX_IP_BLOCK_DAYS} days): many different customers can share one network address.`);
    if (expiresAt.getTime() - now.getTime() > MAX_IP_BLOCK_DAYS * 86_400_000) throw new UserFacingError(`An IP block can last at most ${MAX_IP_BLOCK_DAYS} days.`);
  }

  return prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, input.adminId);
    const existing = await tx.riskListEntry.findFirst({ where: { AND: [activeWhere(now), { listType, kind, value }] }, select: { id: true } });
    if (existing) throw new UserFacingError(`That ${kind.toLowerCase()} is already on the ${listType.toLowerCase()} list.`);
    const row = await tx.riskListEntry.create({
      data: { listType, kind, value, displayValue: raw.slice(0, 120), reason, createdById: input.adminId, expiresAt },
    });
    await recordAudit(tx, { actorId: input.adminId, action: "RISK_LIST_ADDED", entityType: "RISK_LIST", entityId: row.id, detail: { listType, kind, reason, expiresAt: expiresAt?.toISOString() ?? null } });
    return row;
  });
}

export async function disableRiskListEntry(input: { id: string; reason: string; adminId: string }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const reason = String(input.reason ?? "").trim();
  if (reason.length < MIN_LIST_REASON) throw new UserFacingError(`Give a reason (at least ${MIN_LIST_REASON} characters).`);
  await prisma.$transaction(async (tx) => {
    await assertAdminActor(tx, input.adminId);
    const res = await tx.riskListEntry.updateMany({ where: { id: input.id, disabledAt: null }, data: { disabledAt: now, disabledById: input.adminId, disabledReason: reason.slice(0, 300) } });
    if (res.count !== 1) throw new UserFacingError("That entry does not exist or is already disabled.");
    const e = await tx.riskListEntry.findUnique({ where: { id: input.id }, select: { listType: true, kind: true } });
    await recordAudit(tx, { actorId: input.adminId, action: "RISK_LIST_DISABLED", entityType: "RISK_LIST", entityId: input.id, detail: { listType: e?.listType ?? null, kind: e?.kind ?? null, reason: reason.slice(0, 300) } });
  });
}

export type RiskListRow = {
  id: string; listType: RiskListTypeName; kind: RiskListKindName; displayValue: string; reason: string; createdById: string; createdAt: Date;
  expiresAt: Date | null; disabledAt: Date | null; disabledById: string | null; disabledReason: string | null; status: "ACTIVE" | "EXPIRED" | "DISABLED";
};

export function listStatus(e: { disabledAt: Date | null; expiresAt: Date | null }, now: Date): RiskListRow["status"] {
  if (e.disabledAt) return "DISABLED";
  if (e.expiresAt && e.expiresAt <= now) return "EXPIRED";
  return "ACTIVE";
}

export async function listRiskEntries(params: { listType?: RiskListTypeName; kind?: RiskListKindName; includeInactive?: boolean; search?: string } = {}, opts: { now?: Date } = {}): Promise<RiskListRow[]> {
  const now = opts.now ?? new Date();
  const where: Record<string, unknown> = {};
  if (params.listType) where.listType = params.listType;
  if (params.kind) where.kind = params.kind;
  const q = params.search?.trim();
  if (q) {
    const norms = (["PHONE", "EMAIL", "IP"] as const).map((k) => normalizeIdentifier(k, q)).filter((v): v is string => Boolean(v));
    where.OR = [{ displayValue: { contains: q, mode: "insensitive" } }, ...(norms.length ? [{ value: { in: norms } }] : [])];
  }
  const rows = await prisma.riskListEntry.findMany({ where, orderBy: { createdAt: "desc" }, take: 300 });
  return rows
    .map((r) => ({ ...r, status: listStatus(r, now) }) as RiskListRow)
    .filter((r) => params.includeInactive || r.status === "ACTIVE");
}
