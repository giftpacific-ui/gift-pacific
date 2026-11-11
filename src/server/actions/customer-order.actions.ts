"use server";

import { revalidatePath } from "next/cache";
import { requestRefund } from "@/server/services/order.service";

export type RefundActionResult = { success: true } | { success: false; message: string };

export async function requestRefundAction(
  orderNumber: string,
  reason: string,
): Promise<RefundActionResult> {
  if (!reason.trim() || reason.trim().length < 10) {
    return { success: false, message: "Please provide a bit more detail (at least 10 characters)." };
  }
  try {
    await requestRefund(orderNumber, reason.trim());
    revalidatePath(`/account/orders/${orderNumber}`);
    revalidatePath("/account/orders");
    return { success: true };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Could not submit refund request.",
    };
  }
}
