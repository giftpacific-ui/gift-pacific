"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { consumeRateLimit, RATE_LIMITS, throttledMessage } from "@/lib/rate-limit";
import { recheckOrderFraud, rejectAdvancePayment, reviewTrustOrder, saveAdvanceSettings, verifyAdvancePayment, waiveAdvance } from "@/server/services/advance.service";

type Result = { success: true } | { success: false; message: string };
const refresh = (orderId?: string) => { revalidatePath("/admin/orders"); if (orderId) revalidatePath(`/admin/orders/${orderId}`); };

export async function verifyAdvanceAction(input: { orderId: string; paymentId: string; providerRef: string; amount: number }): Promise<Result> {
  const admin = await requireAdmin();
  try {
    await verifyAdvancePayment({ paymentId: String(input?.paymentId), adminId: admin.id, providerRef: String(input?.providerRef ?? ""), amount: Number(input?.amount) });
    refresh(input?.orderId);
    return { success: true };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not verify the payment.") }; }
}

export async function rejectAdvanceAction(input: { orderId: string; paymentId: string; reason: string }): Promise<Result> {
  const admin = await requireAdmin();
  try {
    await rejectAdvancePayment({ paymentId: String(input?.paymentId), adminId: admin.id, reason: String(input?.reason ?? "") });
    refresh(input?.orderId);
    return { success: true };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not reject the payment.") }; }
}

export async function waiveAdvanceAction(input: { orderId: string; reason: string }): Promise<Result> {
  const admin = await requireAdmin();
  try {
    await waiveAdvance({ orderId: String(input?.orderId), adminId: admin.id, reason: String(input?.reason ?? "") });
    refresh(input?.orderId);
    return { success: true };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not waive the advance.") }; }
}

export async function reviewTrustAction(input: { orderId: string; note: string }): Promise<Result> {
  const admin = await requireAdmin();
  try {
    await reviewTrustOrder({ orderId: String(input?.orderId), adminId: admin.id, note: String(input?.note ?? "") });
    refresh(input?.orderId);
    return { success: true };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not record the review.") }; }
}

export async function saveAdvanceSettingsAction(input: {
  enabled: boolean; zones: string[]; standardAmount: number; reducedAmount: number; zeroAtFullTrust: boolean;
  lowBelow: number; reducedFrom: number; fullAt: number; instructions: string; reviewEnabled?: boolean;
}): Promise<Result> {
  const admin = await requireAdmin();
  try {
    await saveAdvanceSettings({
      enabled: Boolean(input?.enabled), zones: (input?.zones ?? []) as never, standardAmount: Number(input?.standardAmount), reducedAmount: Number(input?.reducedAmount),
      zeroAtFullTrust: Boolean(input?.zeroAtFullTrust), lowBelow: Number(input?.lowBelow), reducedFrom: Number(input?.reducedFrom), fullAt: Number(input?.fullAt),
      instructions: String(input?.instructions ?? ""), reviewEnabled: input?.reviewEnabled !== false,
    }, admin.id);
    revalidatePath("/admin/advance");
    return { success: true };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not save the advance policy.") }; }
}

/** Manual fraud recheck: ADMIN only (requireAdmin here AND an active-admin check inside the service), at most 20 per admin per hour, 60 s gap per order, audited. */
export async function recheckFraudAction(input: { orderId: string }): Promise<Result> {
  const admin = await requireAdmin();
  const throttle = await consumeRateLimit(RATE_LIMITS.fraudRecheck, [admin.id]);
  if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };
  try {
    await recheckOrderFraud({ orderId: String(input?.orderId), adminId: admin.id });
    refresh(input?.orderId);
    return { success: true };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not recheck the fraud result.") }; }
}
