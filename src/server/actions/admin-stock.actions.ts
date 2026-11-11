"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { adjustStock } from "@/server/services/stock-adjustment.service";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

export async function adjustStockAction(
  productId: string,
  variantId: string | null,
  delta: number,
  reason: string,
  idempotencyKey?: string,
): Promise<AdminActionResult & { stockAfter?: number }> {
  const admin = await requireAdmin();
  try {
    const { stockAfter } = await adjustStock({ productId, variantId, delta, reason, adminId: admin.id, idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null });
    revalidatePath(`/admin/products/${productId}`);
    revalidatePath("/admin");
    return { success: true, stockAfter };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not adjust the stock.") };
  }
}
