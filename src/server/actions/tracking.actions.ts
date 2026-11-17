"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { retryTrackingEvent, runTrackingMaintenance } from "@/server/services/tracking-event.service";

export type TrackingActionResult = { success: true; message: string } | { success: false; message: string };

/** Admin: one more delivery attempt for a failed (or "not configured") server event. Idempotent: the event id never changes. */
export async function retryTrackingEventAction(logId: string): Promise<TrackingActionResult> {
  await requireAdmin();
  if (typeof logId !== "string" || logId.length > 64) return { success: false, message: "Invalid event." };
  const outcome = await retryTrackingEvent(logId);
  revalidatePath("/admin/settings");
  if (outcome === "sent") return { success: true, message: "Event delivered." };
  if (outcome === "not_claimed") return { success: false, message: "This event cannot be retried (already sent, skipped, or in progress)." };
  if (outcome === "skipped") return { success: false, message: "The event was skipped (see the reason in the list)." };
  return { success: false, message: "Delivery failed again. See the error in the list; fix the cause and retry." };
}

/** Admin: runs the same job the scheduler runs (back-fill, retries, cleanup). */
export async function runTrackingMaintenanceAction(): Promise<TrackingActionResult> {
  await requireAdmin();
  const s = await runTrackingMaintenance();
  revalidatePath("/admin/settings");
  const d = s.delivered;
  return { success: true, message: `Queued ${s.queued}, sent ${d.sent}, retry scheduled ${d.retry_scheduled}, failed ${d.failed}, skipped ${d.skipped}.` };
}
