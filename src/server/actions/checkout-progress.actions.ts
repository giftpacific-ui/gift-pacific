"use server";

import { discardCheckoutProgress, saveCheckoutProgress, type SaveProgressResult } from "@/server/services/incomplete-checkout.service";

/**
 * Autosave of the checkout form. Open to guests by design (it identifies the visitor from the server-side session / httpOnly cart cookie only),
 * strictly validated, rate limited, and it returns only a coarse result: never a record id or anything stored.
 */
export async function saveCheckoutProgressAction(input: unknown): Promise<SaveProgressResult> {
  try {
    return await saveCheckoutProgress(input);
  } catch {
    // Saving progress is a convenience: it must never surface an error to the customer.
    return { saved: false, reason: "invalid" };
  }
}

/** The customer unticked "save my progress": their own open record is deleted. */
export async function discardCheckoutProgressAction(): Promise<{ discarded: number }> {
  try {
    return await discardCheckoutProgress();
  } catch {
    return { discarded: 0 };
  }
}
