"use server";

import { syncOrderPayment } from "@/server/services/advance.service";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/prisma";
import { adminUpdateOrderStatus } from "@/server/services/order.service";
import { saveManualCourier } from "@/server/services/courier.service";
import type { OrderStatus, PaymentStatus } from "@prisma/client";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";
import { toUserMessage } from "@/lib/errors";


export async function updateOrderStatusAction(
  orderId: string,
  status: OrderStatus,
  note?: string,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  try {
    await adminUpdateOrderStatus(orderId, status, note, { adminId: admin.id });
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not update the order status.") };
  }
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  return { success: true };
}

export async function updateOrderTrackingAction(
  orderId: string,
  data: { courierName?: string; trackingNumber?: string; trackingUrl?: string },
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  try {
    // Manual fallback entry. URL safety + "not while API-booked" are enforced in the service.
    await saveManualCourier(orderId, data, { adminId: admin.id });
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not save tracking info.") };
  }
  revalidatePath(`/admin/orders/${orderId}`);
  return { success: true };
}

/**
 * The payment status is DERIVED from verified payment records and recorded refunds (see derivePayment). It cannot be typed in: a hand-set PAID
 * would turn a claim or a partial payment into "fully paid". This action therefore only re-derives it (fixing a stale cache) and tells the admin
 * how to change it for real: verify a payment, or record a refund. The `paymentStatus` argument is accepted for compatibility and ignored.
 */
export async function updatePaymentStatusAction(
  orderId: string,
  _requested?: PaymentStatus,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    const r = await prisma.$transaction((tx) => syncOrderPayment(tx, orderId));
    revalidatePath(`/admin/orders/${orderId}`);
    if (r.drift) return { success: false, message: "The recorded advance differs from the verified payment records. Review the payments in the Advance panel; nothing was changed." };
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not update payment status.") };
  }
}

export async function updateOrderAdminNoteAction(
  orderId: string,
  adminNote: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await prisma.order.update({ where: { id: orderId }, data: { adminNote: adminNote.trim().slice(0, 2000) } });
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not save the note.") };
  }
  revalidatePath(`/admin/orders/${orderId}`);
  return { success: true };
}

export async function approveRefundAction(orderId: string): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  try {
    // Transition policy + guarded update live in adminUpdateOrderStatus
    // (REFUND_REQUESTED → REFUNDED); a non-pending order is rejected there.
    await adminUpdateOrderStatus(orderId, "REFUNDED", "Refund approved by admin.", { adminId: admin.id });
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not approve the refund.") };
  }
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  return { success: true };
}

export async function rejectRefundAction(orderId: string, note?: string): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  try {
    // A refund can only have been requested from DELIVERED, so rejecting
    // returns the order there (REFUND_REQUESTED → DELIVERED).
    await adminUpdateOrderStatus(orderId, "DELIVERED", note || "Refund request rejected.", { adminId: admin.id });
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not reject the refund.") };
  }
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  return { success: true };
}
