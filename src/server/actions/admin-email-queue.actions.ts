"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { adminRetryEmailJobs, type RetryJobResult } from "@/server/services/admin-email-queue.service";
import { adminSendAbandonedCartReminders } from "@/server/services/abandoned-cart-email.service";

/**
 * Server actions for the two admin-triggered sending actions that are not campaigns: manual Retry of selected e-mail jobs, and abandoned-cart reminders.
 * Each one requires an authenticated ADMIN first (requireAdmin throws otherwise) and the service checks the admin again. Only ids (and the abandoned-cart period)
 * come from the browser. Each action awaits ONE bounded run of the existing queue worker inside this request; the pages that host these actions declare
 * `maxDuration = 60`. Nothing here schedules, polls or retries by itself.
 */

export type QueueActionResult<T extends object = object> = ({ success: true; message: string } & T) | { success: false; message: string; code?: string };

export async function retryEmailJobsAction(jobIds: unknown): Promise<QueueActionResult<{ sent: number; refused: number; notProcessed: number; results: RetryJobResult[] }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminRetryEmailJobs(admin.id, { jobIds });
    if (!res.ok) return { success: false, message: res.message, code: res.code };
    revalidatePath("/admin/email-marketing/queue");
    return { success: true, message: res.message, sent: res.delivery?.sent ?? 0, refused: res.refused, notProcessed: res.notProcessed, results: res.results };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The retry could not be completed. Check the queue before trying again.", "email-queue.retry") };
  }
}

export async function sendAbandonedCartRemindersAction(cartIds: unknown, hours: unknown): Promise<QueueActionResult<{ queued: number; sent: number; waiting: number; skipped: { cartId: string; reason: string; label: string }[] }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminSendAbandonedCartReminders(admin.id, { cartIds, hours });
    if (!res.ok) return { success: false, message: res.message, code: res.code };
    revalidatePath("/admin/abandoned-carts");
    revalidatePath("/admin/email-marketing/queue");
    return { success: true, message: res.message, queued: res.queued, sent: res.delivery?.sent ?? 0, waiting: res.delivery?.waiting ?? 0, skipped: res.skipped };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The reminders could not be sent. Check the carts before trying again.", "abandoned-cart.send") };
  }
}
