import "server-only";

import { prisma } from "@/lib/db/prisma";
import type { CouponType } from "@prisma/client";

export async function adminListCoupons() {
  const coupons = await prisma.coupon.findMany({
    orderBy: { createdAt: "desc" },
  });

  return coupons.map((coupon) => ({
    ...coupon,
    value: coupon.value.toString(),
    minPurchase: coupon.minPurchase?.toString() ?? null,
    maxDiscount: coupon.maxDiscount?.toString() ?? null,
  }));
}

export type CouponInput = {
  code: string;
  type: CouponType;
  value: number;
  minPurchase?: number | null;
  maxDiscount?: number | null;
  usageLimit?: number | null;
  perUserLimit?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  isActive: boolean;
};

export async function adminCreateCoupon(input: CouponInput) {
  return prisma.coupon.create({
    data: {
      ...input,
      code: input.code.toUpperCase(),
    },
  });
}

export async function adminUpdateCoupon(id: string, input: CouponInput) {
  return prisma.coupon.update({
    where: { id },
    data: {
      ...input,
      code: input.code.toUpperCase(),
    },
  });
}

export async function adminDeleteCoupon(id: string) {
  return prisma.coupon.delete({
    where: { id },
  });
}
