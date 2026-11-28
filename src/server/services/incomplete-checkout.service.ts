import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getSession, requireAdmin } from "@/lib/auth/current-user";
import { peekGuestToken } from "@/lib/cart/guest-token";
import { normalizeBdPhone } from "@/lib/advance-policy";
import { RATE_LIMITS, clientAddress, consumeRateLimit } from "@/lib/rate-limit";
import { logServerError } from "@/lib/logger";
import { peekCurrentCartDTO } from "@/server/services/cart.service";
import { getDeliveryCharge } from "@/server/services/delivery.service";
import {
  MAX_SNAPSHOT_LINES, checkoutProgressSchema, hasSufficientContact, readSnapshotLines, recoveryConfig,
  type RecoveryConfig, type SnapshotLine,
} from "@/lib/checkout-recovery";

/**
 * P7.2 incomplete checkout recovery: saves a customer's checkout progress, de-duplicated per visitor, and links it to the order when one is placed.
 * It sends nothing to anyone. The visitor is identified ONLY by the server-side session or the httpOnly guest cart cookie; ids from the browser are never used.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

export type SaveProgressResult = {
  saved: boolean;
  reason?: "disabled" | "no_consent" | "invalid" | "insufficient" | "no_cart" | "empty_cart" | "already_ordered" | "limited";
};

type Owner = { ownerKey: string; userId: string | null; guestKey: string | null };

function guestKeyOf(token: string): string {
  return `g:${createHmac("sha256", process.env.AUTH_SECRET ?? "").update(`checkout-recovery|${token}`).digest("hex")}`;
}

/** Who is asking, from the server's own knowledge. Null = no session and no guest cookie: nothing to attach a record to. */
async function resolveOwner(): Promise<Owner | null> {
  const session = await getSession();
  const token = await peekGuestToken();
  const guestKey = token ? guestKeyOf(token) : null;
  if (session?.sub) return { ownerKey: `u:${session.sub}`, userId: session.sub, guestKey };
  return guestKey ? { ownerKey: guestKey, userId: null, guestKey } : null;
}

const emailSchema = z.email();

/** Saves (or updates) the caller's ACTIVE record. Silent: callers get only a coarse reason, never a record id. */
export async function saveCheckoutProgress(raw: unknown, config: RecoveryConfig = recoveryConfig()): Promise<SaveProgressResult> {
  if (!config.enabled) return { saved: false, reason: "disabled" };
  const parsed = checkoutProgressSchema.safeParse(raw);
  if (!parsed.success) {
    // consent missing is reported separately so the UI can tell "switched off" from "bad request"
    const consentIssue = parsed.error.issues.some((i) => i.path[0] === "consent");
    return { saved: false, reason: consentIssue ? "no_consent" : "invalid" };
  }
  const input = parsed.data;

  const owner = await resolveOwner();
  if (!owner) return { saved: false, reason: "no_cart" };

  const ip = await clientAddress();
  for (const [rule, id] of [[RATE_LIMITS.checkoutProgressOwner, owner.ownerKey], ...(ip !== "unknown" ? ([[RATE_LIMITS.checkoutProgressIp, ip]] as const) : [])] as const) {
    if (!(await consumeRateLimit(rule, [id])).ok) return { saved: false, reason: "limited" };
  }

  // Only a VALID contact counts. Garbage never gets stored.
  const email = input.email && emailSchema.safeParse(input.email).success ? input.email.toLowerCase() : null;
  const phoneNorm = input.phone ? normalizeBdPhone(input.phone) : null;
  if (!hasSufficientContact({ email, phoneNorm })) return { saved: false, reason: "insufficient" };

  const cart = await peekCurrentCartDTO();
  if (!cart) return { saved: false, reason: "no_cart" };
  if (cart.items.length === 0) {
    // Nothing left to recover: drop the caller's own open record.
    await prisma.incompleteCheckout.deleteMany({ where: { ownerKey: owner.ownerKey, status: "ACTIVE" } });
    return { saved: false, reason: "empty_cart" };
  }

  // A late autosave must not resurrect a checkout whose order already exists.
  if (input.checkoutKey) {
    const placed = await prisma.order.findUnique({ where: { checkoutKey: input.checkoutKey }, select: { id: true } });
    if (placed) return { saved: false, reason: "already_ordered" };
  }

  const lines: SnapshotLine[] = cart.items.slice(0, MAX_SNAPSHOT_LINES).map((i) => ({
    productId: i.productId, variantId: i.variantId, name: i.productName, variant: i.variantName,
    quantity: i.quantity, unitPrice: i.unitPrice, unavailable: !i.inStock,
  }));
  const subtotal = round2(cart.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
  const delivery = input.deliveryZone ? await getDeliveryCharge(input.deliveryZone) : 0;
  const addr = input.shippingAddress;
  const now = new Date();

  const data = {
    userId: owner.userId,
    email,
    phone: phoneNorm,
    phoneNorm,
    customerName: addr?.fullName || null,
    shippingAddress: addr ? ({ ...addr } as Prisma.InputJsonValue) : Prisma.DbNull,
    deliveryZone: input.deliveryZone ?? null,
    couponCode: input.couponCode || null,
    items: lines as unknown as Prisma.InputJsonValue,
    itemCount: cart.items.reduce((sum, i) => sum + i.quantity, 0),
    subtotal,
    estimatedTotal: round2(subtotal + delivery),
    checkoutKey: input.checkoutKey || null,
    lastActivityAt: now,
  };

  // A customer who signed in after starting as a guest: the guest's open record becomes theirs (one record, no duplicate).
  if (owner.userId && owner.guestKey) {
    const guestRec = await prisma.incompleteCheckout.findFirst({ where: { ownerKey: owner.guestKey, status: "ACTIVE" } });
    if (guestRec) {
      const mine = await prisma.incompleteCheckout.findFirst({ where: { ownerKey: owner.ownerKey, status: "ACTIVE" } });
      if (mine) await prisma.incompleteCheckout.deleteMany({ where: { id: guestRec.id, status: "ACTIVE" } });
      else await prisma.incompleteCheckout.updateMany({ where: { id: guestRec.id, status: "ACTIVE" }, data: { ownerKey: owner.ownerKey, userId: owner.userId } });
    }
  }

  const update = () => prisma.incompleteCheckout.updateMany({ where: { ownerKey: owner.ownerKey, status: "ACTIVE" }, data: { ...data, consentAt: now } });
  const first = await update();
  if (first.count === 0) {
    try {
      await prisma.incompleteCheckout.create({ data: { ...data, ownerKey: owner.ownerKey, status: "ACTIVE", currency: "BDT", consentAt: now } });
    } catch (error) {
      // Two saves raced: the partial unique index (one ACTIVE row per owner) let only one create through; the loser updates it.
      if ((error as { code?: string })?.code !== "P2002") throw error;
      await update();
    }
  }
  return { saved: true };
}

/** The customer withdrew (unticked the box): their own open record is deleted. Only ever touches the caller's record. */
export async function discardCheckoutProgress(): Promise<{ discarded: number }> {
  const owner = await resolveOwner();
  if (!owner) return { discarded: 0 };
  const keys = [owner.ownerKey, ...(owner.guestKey && owner.guestKey !== owner.ownerKey ? [owner.guestKey] : [])];
  const r = await prisma.incompleteCheckout.deleteMany({ where: { ownerKey: { in: keys }, status: "ACTIVE" } });
  return { discarded: r.count };
}

/**
 * Called right after an order was placed: the caller's open record becomes CONVERTED and is linked to the order (kept for audit, never purged).
 * Never throws: a failure here must not turn a successful order into an error.
 */
export async function markCheckoutConverted(orderId: string, checkoutKey?: string | null): Promise<boolean> {
  try {
    const owner = await resolveOwner();
    if (!owner) return false;
    const keys = [owner.ownerKey, ...(owner.guestKey && owner.guestKey !== owner.ownerKey ? [owner.guestKey] : [])];
    const open = await prisma.incompleteCheckout.findMany({ where: { ownerKey: { in: keys }, status: "ACTIVE" }, orderBy: { lastActivityAt: "desc" } });
    if (open.length === 0) return false;
    const primary = (checkoutKey && open.find((r: { checkoutKey: string | null }) => r.checkoutKey === checkoutKey)) || open.find((r: { ownerKey: string }) => r.ownerKey === owner.ownerKey) || open[0];
    const done = await prisma.incompleteCheckout.updateMany({
      where: { id: primary.id, status: "ACTIVE" },
      data: { status: "CONVERTED", orderId, convertedAt: new Date() },
    });
    // Any other open duplicate of the same visitor has nothing left to recover.
    await prisma.incompleteCheckout.deleteMany({ where: { ownerKey: { in: keys }, status: "ACTIVE", id: { not: primary.id } } });
    return done.count === 1;
  } catch (error) {
    logServerError("checkout-recovery.convert", error);
    return false;
  }
}

/**
 * Expiry + cleanup (scheduled route and the admin button). Only ACTIVE records are expired, and expiry scrubs personal details; only EXPIRED records
 * that never produced an order are deleted, and only after the purge window. CONVERTED records (linked to an order) are never touched.
 */
export async function cleanupIncompleteCheckouts(opts: { now?: Date; config?: RecoveryConfig } = {}) {
  const now = opts.now ?? new Date();
  const config = opts.config ?? recoveryConfig();
  const expireBefore = new Date(now.getTime() - config.expiryDays * 86_400_000);
  const purgeBefore = new Date(now.getTime() - config.purgeDays * 86_400_000);
  const expired = await prisma.incompleteCheckout.updateMany({
    where: { status: "ACTIVE", orderId: null, lastActivityAt: { lt: expireBefore } },
    data: { status: "EXPIRED", expiredAt: now, email: null, phone: null, phoneNorm: null, customerName: null, shippingAddress: Prisma.DbNull, couponCode: null, userId: null },
  });
  const purged = await prisma.incompleteCheckout.deleteMany({ where: { status: "EXPIRED", orderId: null, expiredAt: { lt: purgeBefore } } });
  return { expired: expired.count, purged: purged.count };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Admin (every function authorises the caller itself)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const INCOMPLETE_PAGE_SIZE = 20;
export type IncompleteListParams = { q?: string; status?: string; kind?: string; page?: number };

export async function adminListIncompleteCheckouts(params: IncompleteListParams = {}) {
  await requireAdmin();
  const status = ["ACTIVE", "CONVERTED", "EXPIRED"].includes(params.status ?? "") ? (params.status as "ACTIVE" | "CONVERTED" | "EXPIRED") : undefined;
  const q = (params.q ?? "").trim().slice(0, 100);
  const and: Record<string, unknown>[] = [];
  if (status) and.push({ status });
  if (params.kind === "guest") and.push({ ownerKey: { startsWith: "g:" } });
  if (params.kind === "customer") and.push({ ownerKey: { startsWith: "u:" } });
  if (q) {
    const digits = normalizeBdPhone(q);
    and.push({ OR: [{ email: { contains: q, mode: "insensitive" } }, { customerName: { contains: q, mode: "insensitive" } }, { phone: { contains: digits ?? q } }] });
  }
  const where = (and.length ? { AND: and } : {}) as Prisma.IncompleteCheckoutWhereInput;
  const page = Number.isInteger(params.page) && (params.page as number) > 0 ? (params.page as number) : 1;
  const [rows, total, counts] = await Promise.all([
    prisma.incompleteCheckout.findMany({ where, orderBy: [{ lastActivityAt: "desc" }, { id: "asc" }], skip: (page - 1) * INCOMPLETE_PAGE_SIZE, take: INCOMPLETE_PAGE_SIZE }),
    prisma.incompleteCheckout.count({ where }),
    Promise.all((["ACTIVE", "CONVERTED", "EXPIRED"] as const).map((s) => prisma.incompleteCheckout.count({ where: { status: s } }))),
  ]);
  return {
    items: (rows as unknown as Row[]).map(toAdminRow),
    total, page, pageCount: Math.max(1, Math.ceil(total / INCOMPLETE_PAGE_SIZE)),
    counts: { ACTIVE: counts[0] as number, CONVERTED: counts[1] as number, EXPIRED: counts[2] as number },
  };
}

type Row = {
  id: string; ownerKey: string; userId: string | null; status: "ACTIVE" | "CONVERTED" | "EXPIRED"; email: string | null; phone: string | null; customerName: string | null;
  shippingAddress: unknown; deliveryZone: string | null; couponCode: string | null; items: unknown; itemCount: number; subtotal: unknown; estimatedTotal: unknown;
  currency: string; orderId: string | null; convertedAt: Date | null; expiredAt: Date | null; createdAt: Date; lastActivityAt: Date; consentAt: Date;
};

function toAdminRow(r: Row) {
  const lines = readSnapshotLines(r.items);
  return {
    id: r.id, status: r.status, kind: r.ownerKey.startsWith("u:") ? ("customer" as const) : ("guest" as const), userId: r.userId,
    customerName: r.customerName, email: r.email, phone: r.phone, itemCount: r.itemCount, lines,
    estimatedTotal: Number(r.estimatedTotal), subtotal: Number(r.subtotal), currency: r.currency, deliveryZone: r.deliveryZone,
    lastActivityAt: r.lastActivityAt, createdAt: r.createdAt, orderId: r.orderId, convertedAt: r.convertedAt, expiredAt: r.expiredAt,
  };
}

export async function adminGetIncompleteCheckout(id: string) {
  await requireAdmin();
  const r = (await prisma.incompleteCheckout.findUnique({ where: { id } })) as unknown as Row | null;
  if (!r) return null;
  const order = r.orderId ? await prisma.order.findUnique({ where: { id: r.orderId }, select: { id: true, orderNumber: true, status: true, total: true } }) : null;
  const a = (r.shippingAddress && typeof r.shippingAddress === "object" ? r.shippingAddress : {}) as Record<string, string>;
  return {
    ...toAdminRow(r), couponCode: r.couponCode, consentAt: r.consentAt, address: a,
    order: order ? { id: order.id as string, orderNumber: order.orderNumber as string, status: order.status as string, total: Number(order.total) } : null,
  };
}

export async function adminRunIncompleteCheckoutCleanup() {
  await requireAdmin();
  return cleanupIncompleteCheckouts();
}
