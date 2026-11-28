"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { confirmCodCollection, recordCodEntry, resolveCodDiscrepancy } from "@/server/services/courier-cod.service";

export async function recordCodEntryAction(input: {
  orderId: string;
  kind: string;
  amount: number;
  reference?: string;
  note?: string;
}): Promise<{ success: true } | { success: false; message: string }> {
  const admin = await requireAdmin();
  try {
    await recordCodEntry({ orderId: input.orderId, adminId: admin.id, kind: input.kind, amount: input.amount, reference: input.reference, note: input.note });
    revalidatePath("/admin/courier/cod");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not save the entry.") };
  }
}

/** Admin-only: staff statement that a courier-delivered order's cash was collected (the only way such an order becomes PAID). */
export async function confirmCodCollectionAction(input: { orderId: string; reason: string }): Promise<{ success: true } | { success: false; message: string }> {
  const admin = await requireAdmin();
  try {
    await confirmCodCollection({ orderId: input.orderId, adminId: admin.id, reason: input.reason });
    revalidatePath("/admin/courier/cod");
    revalidatePath(`/admin/orders/${input.orderId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not confirm the collection.", "courier.cod-confirm") };
  }
}

/** Admin-only: resolve one open COD discrepancy with a mandatory reason. */
export async function resolveCodDiscrepancyAction(input: { orderId: string; flagCode: string; amount: number; action: string; reason: string }): Promise<{ success: true } | { success: false; message: string }> {
  const admin = await requireAdmin();
  try {
    await resolveCodDiscrepancy({ orderId: input.orderId, adminId: admin.id, flagCode: input.flagCode, amount: input.amount, action: input.action, reason: input.reason });
    revalidatePath("/admin/courier/cod");
    revalidatePath(`/admin/orders/${input.orderId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not save the resolution.", "courier.cod-resolve") };
  }
}
