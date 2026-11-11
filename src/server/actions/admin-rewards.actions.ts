"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { saveRewardSettings } from "@/server/services/reward.service";

type Result = { success: true } | { success: false; message: string };

export async function saveRewardSettingsAction(input: {
  rewardEnabled: boolean; rewardDeliveryPercent: number; rewardMinOrderAmount: number;
  rewardMaxDiscount: number | null; rewardValidityDays: number | null; rewardOncePerCustomer: boolean; rewardStackWithCoupon: boolean;
}): Promise<Result> {
  await requireAdmin();
  try {
    await saveRewardSettings({
      rewardEnabled: Boolean(input?.rewardEnabled),
      rewardDeliveryPercent: Number(input?.rewardDeliveryPercent),
      rewardMinOrderAmount: Number(input?.rewardMinOrderAmount),
      rewardMaxDiscount: input?.rewardMaxDiscount === null || input?.rewardMaxDiscount === undefined ? null : Number(input.rewardMaxDiscount),
      rewardValidityDays: input?.rewardValidityDays === null || input?.rewardValidityDays === undefined ? null : Number(input.rewardValidityDays),
      rewardOncePerCustomer: Boolean(input?.rewardOncePerCustomer),
      rewardStackWithCoupon: Boolean(input?.rewardStackWithCoupon),
    });
    revalidatePath("/admin/rewards");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not save the reward settings.") };
  }
}
