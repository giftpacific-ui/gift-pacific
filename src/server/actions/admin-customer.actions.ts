"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminToggleCustomerActive } from "@/server/services/admin-customer.service";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

export async function toggleCustomerActiveAction(
  userId: string,
  isActive: boolean,
): Promise<AdminActionResult> {
  await requireAdmin();
  const result = await adminToggleCustomerActive(userId, isActive);
  if (result.count === 0) {
    return { success: false, message: "Customer not found." };
  }
  revalidatePath(`/admin/customers/${userId}`);
  revalidatePath("/admin/customers");
  return { success: true };
}
