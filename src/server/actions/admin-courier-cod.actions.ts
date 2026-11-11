"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { recordCodEntry } from "@/server/services/courier-cod.service";

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
