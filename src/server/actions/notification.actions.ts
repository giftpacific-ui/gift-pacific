"use server";

import { revalidatePath } from "next/cache";
import { markAllMyNotificationsRead, markMyNotificationRead } from "@/server/services/notification.service";

/** Ownership is enforced in the service (the WHERE clause carries the session user); the id alone grants nothing. */
export async function markNotificationReadAction(id: string): Promise<void> {
  await markMyNotificationRead(id);
  revalidatePath("/account", "layout");
}

export async function markAllNotificationsReadAction(): Promise<void> {
  await markAllMyNotificationsRead();
  revalidatePath("/account", "layout");
}
