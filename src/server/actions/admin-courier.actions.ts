"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import {
  bookOrderWithCourier,
  bulkBookOrders,
  type BulkBookingResult,
  refreshCourierStatus,
} from "@/server/services/courier.service";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

export type CourierActionResult = AdminActionResult & { note?: string };

/**
 * Admin-only. `confirmUncertain` is true only when the admin has ticked the
 * "I checked the courier portal" confirmation after an UNCERTAIN attempt.
 */
export async function bookCourierAction(
  orderId: string,
  confirmUncertain = false,
  provider?: string,
): Promise<CourierActionResult> {
  const admin = await requireAdmin();
  try {
    // `provider` is only a key: the service validates it against the configured couriers and uses ITS server-side credentials.
    const result = await bookOrderWithCourier(orderId, { actor: { adminId: admin.id }, confirmUncertain: confirmUncertain === true, provider: typeof provider === "string" ? provider : null });
    revalidatePath(`/admin/orders/${orderId}`);
    return result.booked
      ? { success: true, note: "Booked with the courier." }
      : { success: false, message: result.message };
  } catch (error) {
    revalidatePath(`/admin/orders/${orderId}`);
    return { success: false, message: toUserMessage(error, "Could not book the courier.", "courier.book") };
  }
}

export async function refreshCourierStatusAction(orderId: string): Promise<CourierActionResult> {
  const admin = await requireAdmin();
  try {
    const result = await refreshCourierStatus(orderId, { adminId: admin.id });
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath("/admin/orders");
    if (result.applied) return { success: true, note: `Order moved to ${result.steps[result.steps.length - 1].replaceAll("_", " ")}.` };
    return {
      success: true,
      note:
        result.reason === "duplicate"
          ? "Courier status is unchanged."
          : "Courier status recorded; no order status change was needed.",
    };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not refresh the courier status.", "courier.refresh") };
  }
}

/** Admin-only. Each order gets its own result; a failure never blocks the others. */
export async function bulkBookCourierAction(orderIds: string[], provider?: string): Promise<{ success: true; results: BulkBookingResult[] } | { success: false; message: string }> {
  const admin = await requireAdmin();
  try {
    if (!Array.isArray(orderIds) || orderIds.length === 0) return { success: false, message: "Select at least one order." };
    const results = await bulkBookOrders(orderIds, {}, { actor: { adminId: admin.id }, provider: typeof provider === "string" ? provider : null });
    revalidatePath("/admin/orders");
    revalidatePath("/admin/courier");
    revalidatePath("/admin/courier/bulk");
    return { success: true, results };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Bulk booking failed.") };
  }
}
