"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { couponFormSchema } from "@/lib/validations/admin";
import { validateCouponRules } from "@/lib/validation-rules";
import { toUserMessage } from "@/lib/errors";
import { parseScheduleWindow } from "@/lib/schedule";
import {
  adminCreateCoupon,
  adminUpdateCoupon,
  adminDeleteCoupon,
} from "@/server/services/admin-coupon.service";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

function toNullableNumber(value: number | "" | undefined): number | null {
  return value === "" || value === undefined ? null : value;
}

export async function saveCouponAction(
  couponId: string | null,
  raw: Record<string, unknown>,
): Promise<AdminActionResult> {
  await requireAdmin();
  const parsed = couponFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const schedule = parseScheduleWindow(parsed.data.startsAt, parsed.data.endsAt);
  if (!schedule.ok) return { success: false, message: schedule.message };

  const data = {
    code: parsed.data.code,
    type: parsed.data.type,
    value: parsed.data.value,
    minPurchase: toNullableNumber(parsed.data.minPurchase),
    maxDiscount: toNullableNumber(parsed.data.maxDiscount),
    usageLimit: toNullableNumber(parsed.data.usageLimit),
    perUserLimit: toNullableNumber(parsed.data.perUserLimit),
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    isActive: parsed.data.isActive,
  };

  // Business rules (percentage <= 100, positive amounts, start < end, sane limits).
  const ruleError = validateCouponRules({
    code: data.code,
    type: data.type,
    value: data.value,
    minPurchase: data.minPurchase,
    maxDiscount: data.maxDiscount,
    usageLimit: data.usageLimit,
    perUserLimit: data.perUserLimit,
    startsAt: data.startsAt,
    endsAt: data.endsAt,
  });
  if (ruleError) return { success: false, message: ruleError };

  try {
    const coupon = couponId ? await adminUpdateCoupon(couponId, data) : await adminCreateCoupon(data);
    revalidatePath("/admin/coupons");
    return { success: true, id: coupon.id };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return { success: false, message: "Could not save coupon — the code is already in use." };
    }
    return { success: false, message: toUserMessage(error, "Could not save coupon.") };
  }
}

export async function deleteCouponAction(couponId: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminDeleteCoupon(couponId);
    revalidatePath("/admin/coupons");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not delete the coupon.") };
  }
}
