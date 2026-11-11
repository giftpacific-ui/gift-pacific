"use server";

import { RATE_LIMITS, clientAddress, consumeRateLimit, throttledMessage } from "@/lib/rate-limit";
import { submitApplication, type ApplyResult } from "@/server/services/career.service";
import { logServerError } from "@/lib/logger";

/** Public job application. Throttled per client and protected by a honeypot field. */
export async function applyToJobAction(slug: string, payload: Record<string, unknown>): Promise<ApplyResult> {
  try {
    const throttle = await consumeRateLimit(RATE_LIMITS.jobApplication, [await clientAddress()]);
    if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };
    return await submitApplication(String(slug), payload ?? {});
  } catch (error) {
    logServerError("career.apply", error);
    return { success: false, message: "Could not send your application. Please try again." };
  }
}
