"use server";

import { revalidatePath } from "next/cache";
import { toUserMessage } from "@/lib/errors";
import { buyAgain, type BuyAgainResult } from "@/server/services/reorder.service";

export async function buyAgainAction(
  orderNumber: string,
  orderItemId?: string,
): Promise<({ success: true } & BuyAgainResult) | { success: false; message: string }> {
  try {
    const result = await buyAgain(orderNumber, orderItemId);
    revalidatePath("/cart");
    return { success: true, ...result };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not add these items to your cart.") };
  }
}
