"use server";

import { revalidatePath } from "next/cache";
import { getSession, requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { RATE_LIMITS, consumeRateLimit, throttledMessage } from "@/lib/rate-limit";
import {
  initiateBkashAdvance,
  recordGatewayRefundInAccounting,
  recoverStuckGatewayTransactions,
  approveRefundAttestation,
  rejectRefundAttestation,
  resolveUncertainGatewayRefund,
  sendNeverSubmittedGatewayRefund,
  recheckGatewayTransaction,
  refundGatewayTransaction,
  syncGatewayRefund,
  testBkashConnection,
} from "@/server/services/gateway-payment.service";

type Result<T = object> = ({ success: true } & T) | { success: false; message: string };

/** Customer: the only input is the order number. The amount, ownership and eligibility are all decided on the server. */
export async function startBkashPaymentAction(orderNumber: string): Promise<Result<{ redirectUrl: string }>> {
  try {
    const session = await getSession();
    if (!session) return { success: false, message: "Please sign in to pay for your order." };
    const throttle = await consumeRateLimit(RATE_LIMITS.paymentStart, [session.sub]);
    if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };
    const { redirectUrl } = await initiateBkashAdvance(orderNumber);
    return { success: true, redirectUrl };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not start the payment.") };
  }
}

export async function recheckGatewayTransactionAction(id: string): Promise<Result<{ status: string }>> {
  const admin = await requireAdmin();
  try {
    const txn = await recheckGatewayTransaction(id, admin.id);
    revalidatePath("/admin/accounts/payments");
    revalidatePath("/admin/integrations");
    return { success: true, status: txn.status };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not re-check this payment.") };
  }
}

export async function refundGatewayTransactionAction(input: { transactionId: string; amount: number; reason: string; idempotencyKey: string }): Promise<Result<{ status: string }>> {
  const admin = await requireAdmin();
  try {
    const refund = await refundGatewayTransaction({ ...input, adminId: admin.id });
    revalidatePath("/admin/accounts/payments");
    return { success: true, status: refund.status };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not send the refund.") };
  }
}

export async function syncGatewayRefundAction(refundId: string): Promise<Result<{ status: string }>> {
  const admin = await requireAdmin();
  try {
    const refund = await syncGatewayRefund(refundId, admin.id);
    revalidatePath("/admin/accounts/payments");
    return { success: true, status: refund.status };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not check the refund.") };
  }
}

export async function testBkashConnectionAction(): Promise<Result> {
  await requireAdmin();
  const result = await testBkashConnection();
  revalidatePath("/admin/integrations");
  return result.ok ? { success: true } : { success: false, message: result.message };
}

export async function recoverStuckGatewayTransactionsAction(): Promise<Result<{ totalStuck: number; settled: number; stillOpen: number; failed: number; notReached: number; lateCompleted: number }>> {
  const admin = await requireAdmin();
  try {
    const r = await recoverStuckGatewayTransactions(admin.id);
    revalidatePath("/admin/accounts/payments");
    return { success: true, ...r };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not re-check the stuck payments.") };
  }
}

export async function recordGatewayRefundInAccountingAction(refundId: string): Promise<Result> {
  const admin = await requireAdmin();
  try {
    const r = await recordGatewayRefundInAccounting(refundId, admin.id, { acknowledgeExistingRefunds: true });
    revalidatePath("/admin/accounts/payments");
    revalidatePath("/admin/accounts");
    return r.recorded ? { success: true } : { success: false, message: r.message ?? "Could not record the refund." };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not record the refund.") };
  }
}

export async function sendNeverSubmittedRefundAction(refundId: string): Promise<Result<{ status: string }>> {
  const admin = await requireAdmin();
  try {
    const refund = await sendNeverSubmittedGatewayRefund(refundId, admin.id);
    revalidatePath("/admin/accounts/payments");
    return { success: true, status: refund.status };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not send the refund.") };
  }
}

export async function resolveUncertainRefundAction(input: { refundId: string; outcome: "REFUNDED" | "NOT_REFUNDED"; providerRefundTrxId?: string; confirmedOn?: string; evidence: string; note: string }): Promise<Result<{ status: string; awaitingApproval: boolean }>> {
  const admin = await requireAdmin();
  try {
    const { refund, awaitingApproval } = await resolveUncertainGatewayRefund({ ...input, adminId: admin.id });
    revalidatePath("/admin/accounts/payments");
    revalidatePath("/admin/accounts");
    return { success: true, status: refund.status, awaitingApproval };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not resolve the refund.") };
  }
}

export async function approveRefundAttestationAction(refundId: string): Promise<Result<{ status: string }>> {
  const admin = await requireAdmin();
  try {
    const refund = await approveRefundAttestation(refundId, admin.id);
    revalidatePath("/admin/accounts/payments");
    revalidatePath("/admin/accounts");
    return { success: true, status: refund.status };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not approve the decision.") };
  }
}

export async function rejectRefundAttestationAction(refundId: string, reason: string): Promise<Result<{ status: string }>> {
  const admin = await requireAdmin();
  try {
    const refund = await rejectRefundAttestation(refundId, admin.id, reason);
    revalidatePath("/admin/accounts/payments");
    return { success: true, status: refund.status };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not reject the decision.") };
  }
}
