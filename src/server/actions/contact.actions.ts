"use server";

import { contactFormSchema } from "@/lib/validations/contact";
import { RATE_LIMITS, clientAddress, consumeRateLimit, throttledMessage } from "@/lib/rate-limit";
import { createContactMessage } from "@/server/services/contact.service";
import type { ActionResult } from "@/server/actions/account.actions";

export async function submitContactMessageAction(
  raw: Record<string, unknown>,
): Promise<ActionResult> {
  const parsed = contactFormSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      message: "Please check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const throttle = await consumeRateLimit(RATE_LIMITS.contact, [await clientAddress()]);
  if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };

  await createContactMessage(parsed.data);
  return { success: true };
}
