"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import {
  adminMarkContactMessageRead,
  adminDeleteContactMessage,
} from "@/server/services/admin-contact.service";
import { toUserMessage } from "@/lib/errors";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

export async function markContactReadAction(
  id: string,
  isRead: boolean,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminMarkContactMessageRead(id, isRead);
    revalidatePath("/admin/contacts");
    revalidatePath(`/admin/contacts/${id}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not update the message.") };
  }
}

export async function deleteContactMessageAction(id: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminDeleteContactMessage(id);
    revalidatePath("/admin/contacts");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not delete the message.") };
  }
}
