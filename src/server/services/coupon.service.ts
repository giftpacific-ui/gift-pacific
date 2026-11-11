import "server-only";
import { prisma } from "@/lib/db/prisma";
import type { Coupon } from "@prisma/client";

export type CouponValidationResult =
  | { valid: true; coupon: Coupon; discountAmount: number }
  | { valid: false; message: string };

export async function validateCoupon(
  code: string,
  subtotal: number,
  userId: string | null,
): Promise<CouponValidationResult> {
  const coupon = await prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });

  if (!coupon || !coupon.isActive) {
    return { valid: false, message: "This coupon code is not valid." };
  }

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) {
    return { valid: false, message: "This coupon isn't active yet." };
  }
  if (coupon.endsAt && coupon.endsAt < now) {
    return { valid: false, message: "This coupon has expired." };
  }
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    return { valid: false, message: "This coupon has reached its usage limit." };
  }
  if (coupon.minPurchase && subtotal < Number(coupon.minPurchase)) {
    return {
      valid: false,
      message: `This coupon requires a minimum purchase of ${Number(coupon.minPurchase)}.`,
    };
  }

  if (coupon.perUserLimit !== null && userId) {
    const userUsageCount = await prisma.order.count({
      where: { couponId: coupon.id, userId, status: { not: "CANCELLED" } },
    });
    if (userUsageCount >= coupon.perUserLimit) {
      return { valid: false, message: "You've already used this coupon the maximum number of times." };
    }
  }

  let discountAmount =
    coupon.type === "PERCENTAGE" ? (subtotal * Number(coupon.value)) / 100 : Number(coupon.value);

  if (coupon.maxDiscount) {
    discountAmount = Math.min(discountAmount, Number(coupon.maxDiscount));
  }
  discountAmount = Math.min(discountAmount, subtotal);

  return { valid: true, coupon, discountAmount: Math.round(discountAmount * 100) / 100 };
}
