"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { recalculateOrderRisk, reviewRiskOrder } from "@/server/services/fraud-review.service";
import { runFraudMaintenance, saveFraudPolicy } from "@/server/services/fraud-risk.service";
import { addRiskListEntry, disableRiskListEntry, type RiskListKindName, type RiskListTypeName } from "@/server/services/risk-list.service";

/**
 * Admin entry points for fraud management. Each one re-checks the ADMIN role on the server (requireAdmin) and passes the signed-in admin's id to a
 * service that checks it again (active admin) and validates every field. Nothing here accepts a score, a level or a decision about who may act from the
 * browser: the browser only supplies the order, the decision, and the reason text.
 */
type Result = { success: true; message?: string } | { success: false; message: string };
const refresh = (orderId?: string) => {
  revalidatePath("/admin/fraud");
  revalidatePath("/admin/orders");
  if (orderId) revalidatePath(`/admin/orders/${orderId}`);
};

export async function reviewRiskAction(input: { orderId: string; decision: string; reason: string; assessmentId: string }): Promise<Result> {
  const admin = await requireAdmin();
  try {
    const decision = input?.decision === "REJECTED" ? "REJECTED" : input?.decision === "APPROVED" ? "APPROVED" : null;
    if (!decision) return { success: false, message: "Choose approve or reject." };
    await reviewRiskOrder({ orderId: String(input?.orderId), adminId: admin.id, decision, reason: String(input?.reason ?? ""), assessmentId: String(input?.assessmentId ?? "") });
    refresh(input?.orderId);
    return { success: true, message: decision === "APPROVED" ? "Approved. The order can now be confirmed." : "Rejected. The order was cancelled." };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not record the decision.") }; }
}

export async function recalculateRiskAction(orderId: string): Promise<Result> {
  const admin = await requireAdmin();
  try {
    const r = await recalculateOrderRisk(String(orderId), admin.id);
    refresh(orderId);
    return { success: true, message: `Recalculated: ${r.score}/100 (${r.level.toLowerCase()}).` };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not recalculate the risk.") }; }
}

export async function addRiskListEntryAction(input: { listType: string; kind: string; value: string; reason: string; expiresOn?: string }): Promise<Result> {
  const admin = await requireAdmin();
  try {
    let expiresAt: Date | null = null;
    if (input?.expiresOn) {
      expiresAt = new Date(`${String(input.expiresOn).slice(0, 10)}T23:59:59`);
      if (Number.isNaN(expiresAt.getTime())) return { success: false, message: "Enter a valid expiry date." };
    }
    await addRiskListEntry({
      listType: String(input?.listType) as RiskListTypeName, kind: String(input?.kind) as RiskListKindName,
      value: String(input?.value ?? ""), reason: String(input?.reason ?? ""), expiresAt, adminId: admin.id,
    });
    revalidatePath("/admin/fraud/lists");
    return { success: true, message: "Added." };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not add the entry.") }; }
}

export async function disableRiskListEntryAction(input: { id: string; reason: string }): Promise<Result> {
  const admin = await requireAdmin();
  try {
    await disableRiskListEntry({ id: String(input?.id), reason: String(input?.reason ?? ""), adminId: admin.id });
    revalidatePath("/admin/fraud/lists");
    return { success: true, message: "Disabled." };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not disable the entry.") }; }
}

export async function saveFraudPolicyAction(policy: unknown): Promise<Result> {
  const admin = await requireAdmin();
  try {
    await saveFraudPolicy(policy, admin.id);
    revalidatePath("/admin/fraud/settings");
    return { success: true, message: "Fraud policy saved." };
  } catch (error) { return { success: false, message: toUserMessage(error, "Could not save the policy.") }; }
}

export async function runFraudMaintenanceAction(): Promise<Result> {
  await requireAdmin();
  try {
    const s = await runFraudMaintenance();
    revalidatePath("/admin/fraud/settings");
    return { success: true, message: `IP addresses erased: ${s.ipPurged}. Orders given identity keys: ${s.keysBackfilled}.` };
  } catch (error) { return { success: false, message: toUserMessage(error, "Maintenance failed.") }; }
}
