import "server-only";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { validateRewardSettings, type RewardSettingsInput } from "@/lib/rewards";

type Tx = Prisma.TransactionClient;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alike characters
const newCode = () => "RWD-" + Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join("");

export async function getRewardSettings(): Promise<RewardSettingsInput> {
  const s = await prisma.storeSettings.findUnique({ where: { id: "singleton" } });
  return {
    rewardEnabled: s?.rewardEnabled ?? false,
    rewardDeliveryPercent: s?.rewardDeliveryPercent ?? 50,
    rewardMinOrderAmount: Number(s?.rewardMinOrderAmount ?? 0),
    rewardMaxDiscount: s?.rewardMaxDiscount == null ? null : Number(s.rewardMaxDiscount),
    rewardValidityDays: s?.rewardValidityDays ?? null,
    rewardOncePerCustomer: s?.rewardOncePerCustomer ?? false,
    rewardStackWithCoupon: s?.rewardStackWithCoupon ?? true,
  };
}

export async function saveRewardSettings(input: RewardSettingsInput) {
  const error = validateRewardSettings(input);
  if (error) throw new UserFacingError(error);
  await prisma.storeSettings.upsert({ where: { id: "singleton" }, update: input, create: { id: "singleton", ...input } });
}

/**
 * Called inside the status-change transaction when an order becomes DELIVERED (the qualifying state).
 * Idempotent: `orderId` is UNIQUE on CustomerReward, and an existing row for the order is checked first, so repeated
 * status changes can never issue a second reward for the same order. Guest orders (no account) earn nothing.
 */
export async function issueRewardForDeliveredOrder(tx: Tx, orderId: string, now = new Date()): Promise<{ issued: boolean }> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, userId: true, subtotal: true, discountTotal: true } });
  if (!order?.userId) return { issued: false };
  const settings = await tx.storeSettings.findUnique({ where: { id: "singleton" } });
  if (!settings?.rewardEnabled) return { issued: false };
  if (await tx.customerReward.findFirst({ where: { orderId }, select: { id: true } })) return { issued: false };
  if (settings.rewardOncePerCustomer && (await tx.customerReward.findFirst({ where: { userId: order.userId }, select: { id: true } }))) return { issued: false };
  // Qualifying amount = what the customer actually paid for goods (subtotal after product coupons).
  const qualifying = Number(order.subtotal) - Number(order.discountTotal);
  if (qualifying < Number(settings.rewardMinOrderAmount)) return { issued: false };
  const expiresAt = settings.rewardValidityDays ? new Date(now.getTime() + settings.rewardValidityDays * 86_400_000) : null;
  await tx.customerReward.create({
    data: {
      userId: order.userId, orderId, code: newCode(), percent: settings.rewardDeliveryPercent,
      maxDiscount: settings.rewardMaxDiscount, minOrderAmount: settings.rewardMinOrderAmount,
      stackable: settings.rewardStackWithCoupon, expiresAt,
    },
  });
  return { issued: true };
}

/** A refunded/returned order must not leave its earned (still unused) reward behind. */
export async function revokeRewardEarnedBy(tx: Tx, orderId: string) {
  await tx.customerReward.updateMany({ where: { orderId, status: "AVAILABLE" }, data: { status: "REVOKED" } });
}

/** An order that REDEEMED a reward and was then cancelled/failed before delivery gives it back (if still valid). */
export async function releaseRewardUsedBy(tx: Tx, orderId: string, now = new Date()) {
  const used = await tx.customerReward.findFirst({ where: { usedOrderId: orderId, status: "USED" }, select: { id: true, expiresAt: true } });
  if (!used) return;
  const expired = used.expiresAt !== null && used.expiresAt <= now;
  await tx.customerReward.updateMany({
    where: { id: used.id, usedOrderId: orderId, status: "USED" },
    data: { status: expired ? "EXPIRED" : "AVAILABLE", usedAt: null, usedOrderId: null },
  });
}

export type MyReward = { id: string; code: string; percent: number; maxDiscount: number | null; minOrderAmount: number; stackable: boolean; status: "AVAILABLE" | "USED" | "EXPIRED" | "REVOKED"; expiresAt: Date | null; createdAt: Date };

/** The caller's own rewards only (always filtered by userId). Time-expired ones are reported as EXPIRED. */
export async function listRewardsForUser(userId: string, now = new Date()): Promise<MyReward[]> {
  const rows = await prisma.customerReward.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 });
  return rows.map((r) => ({
    id: r.id, code: r.code, percent: r.percent, maxDiscount: r.maxDiscount == null ? null : Number(r.maxDiscount), minOrderAmount: Number(r.minOrderAmount),
    stackable: r.stackable, status: r.status === "AVAILABLE" && r.expiresAt && r.expiresAt <= now ? "EXPIRED" : r.status, expiresAt: r.expiresAt, createdAt: r.createdAt,
  }));
}
