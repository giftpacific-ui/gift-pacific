"use server";

import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import type { ProviderReport } from "@/lib/courier-intelligence/types";
import { adminCheckProvider, getPhoneRiskSummary, type PhoneRiskSummary } from "@/server/services/courier-intelligence-admin.service";

export type CheckProviderResult =
  | { success: true; phoneValid: boolean; phoneMasked: string | null; report: ProviderReport }
  | { success: false; message: string };

/**
 * Admin-only: one courier's delivery history for ANY valid Bangladesh mobile number. The service re-checks that the caller is an active admin,
 * throttles lookups per admin and audits them (masked phone only). The browser receives only the normalised report: never credentials, never the
 * provider's raw response, never the full phone number back.
 */
export async function checkCourierProviderAction(input: { phone: string; provider: string; fresh?: boolean }): Promise<CheckProviderResult> {
  const admin = await requireAdmin();
  try {
    const r = await adminCheckProvider({ adminId: admin.id, phone: String(input?.phone ?? "").slice(0, 40), provider: input?.provider, fresh: input?.fresh === true });
    return { success: true, phoneValid: r.phoneValid, phoneMasked: r.phoneMasked, report: r.report };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not check this number.", "courier-intelligence.check") };
  }
}

export type PhoneRiskResult = ({ success: true } & PhoneRiskSummary) | { success: false; message: string };

/** Admin-only: what this website already knows about a phone (its order outcomes and the latest stored risk score with reasons). Stored data only: no courier is called. */
export async function lookupPhoneRiskAction(input: { phone: string }): Promise<PhoneRiskResult> {
  const admin = await requireAdmin();
  try {
    return { success: true, ...(await getPhoneRiskSummary({ adminId: admin.id, phone: String(input?.phone ?? "").slice(0, 40) })) };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not look up this number.", "courier-intelligence.risk") };
  }
}
