"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminRunIncompleteCheckoutCleanup } from "@/server/services/incomplete-checkout.service";

export async function runIncompleteCheckoutCleanupAction(): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  try {
    const r = await adminRunIncompleteCheckoutCleanup();
    revalidatePath("/admin/incomplete-checkouts");
    return { success: true, message: `${r.expired} expired, ${r.purged} deleted.` };
  } catch {
    return { success: false, message: "Cleanup failed. Please try again." };
  }
}
