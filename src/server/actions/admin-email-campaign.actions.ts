"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import type { FieldError } from "@/lib/email/template-rules";
import type { AudiencePool, AudienceSummary, CampaignReview, CampaignStatus } from "@/lib/email-campaigns";
import {
  adminCancelCampaign, adminContinueCampaignSending, adminGetAudienceOverview, adminGetCampaignReview, adminPrepareCampaignAudience, adminSaveCampaignDraft, adminSendCampaignNow,
  adminSearchAudienceContacts, adminUnscheduleCampaign, type CampaignAdminFailure,
} from "@/server/services/admin-email-campaign.service";
import { adminPreviewSavedEmailTemplate } from "@/server/services/email-template-designer.service";

/**
 * Server actions for Email marketing > Campaigns (P12-UI-03). Every action requires an authenticated ADMIN first (requireAdmin throws otherwise) and the
 * service checks the admin again; inputs are validated again on the server by the existing services; failures return a fixed safe message (unexpected
 * errors are logged server-side and replaced by a generic text). There is NO scheduling action (no date or time is ever accepted from the browser).
 * `sendCampaignNowAction` hands a DRAFT to the EXISTING dispatcher through the admin service; nothing here talks to SMTP or the queue directly.
 */

const LIST = "/admin/email-marketing/campaigns";
const GENERIC = "Something went wrong. Please try again.";

export type CampaignActionResult<T extends object = object> = ({ success: true } & T) | { success: false; message: string; code?: string; errors?: FieldError[] };
const failure = (res: CampaignAdminFailure): { success: false; message: string; code: string; errors?: FieldError[] } => ({ success: false, message: res.message, code: res.code, errors: res.errors });

export async function saveCampaignDraftAction(input: unknown): Promise<CampaignActionResult<{ id: string; created: boolean; subject: string }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminSaveCampaignDraft(admin.id, input);
    if (!res.ok) return failure(res);
    revalidatePath(LIST);
    return { success: true, id: res.id, created: res.created, subject: res.subject };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The campaign could not be saved. Please try again.", "email-campaigns.save") };
  }
}

/** Preview of a saved template for the wizard: the EXISTING template preview (designer marker removed, sample customer data). */
export async function previewCampaignTemplateAction(templateId: unknown): Promise<CampaignActionResult<{ subject: string; html: string }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminPreviewSavedEmailTemplate(admin.id, templateId);
    return res.ok ? { success: true, subject: res.subject, html: res.html } : { success: false, message: res.message, code: res.code };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The preview could not be built. Please try again.", "email-campaigns.template-preview") };
  }
}

export async function getCampaignAudienceOverviewAction(campaignId: unknown): Promise<CampaignActionResult<{ pool: AudiencePool; audience: AudienceSummary }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminGetAudienceOverview(admin.id, campaignId);
    return res.ok ? { success: true, pool: res.pool, audience: res.audience } : failure(res);
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The audience could not be loaded. Please try again.", "email-campaigns.audience-overview") };
  }
}

export async function searchAudienceContactsAction(query: unknown): Promise<CampaignActionResult<{ contacts: { id: string; email: string; name: string | null; eligible: boolean }[] }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminSearchAudienceContacts(admin.id, query);
    return res.ok ? { success: true, contacts: res.contacts } : failure(res);
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Contacts could not be searched. Please try again.", "email-campaigns.contact-search") };
  }
}

export type PrepareAudienceOutcome = {
  audience: AudienceSummary;
  run: { considered: number; added: number; alreadyPrepared: number; skippedNow: number; excluded: Record<string, number>; recipientCount: number };
};

/** Prepares the audience with the existing service. Only a list of contact ids (or nothing = all contacts) is read from the browser; who is eligible is never. */
export async function prepareCampaignAudienceAction(campaignId: unknown, input: unknown): Promise<CampaignActionResult<PrepareAudienceOutcome>> {
  const admin = await requireAdmin();
  try {
    const res = await adminPrepareCampaignAudience(admin.id, campaignId, input);
    if (!res.ok) return failure(res);
    revalidatePath(LIST);
    const { considered, added, alreadyPrepared, skippedNow, excluded, recipientCount } = res.run;
    return { success: true, audience: res.audience, run: { considered, added, alreadyPrepared, skippedNow, excluded, recipientCount } };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The audience could not be prepared. Please try again.", "email-campaigns.prepare-audience") };
  }
}

export async function getCampaignReviewAction(campaignId: unknown): Promise<CampaignActionResult<{ review: CampaignReview }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminGetCampaignReview(admin.id, campaignId);
    return res.ok ? { success: true, review: res.review } : failure(res);
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The review could not be built. Please try again.", "email-campaigns.review") };
  }
}

type TransitionOutcome = { id: string; status: CampaignStatus; scheduledAt: string | null };

export type SendNowOutcome = { id: string; status: string; outcome: "queued" | "in_progress" | "partial"; enqueued: number; skipped: number; failed: number; message: string; sent: number; waiting: number };

/** Sends a DRAFT campaign now. Only the campaign id comes from the browser; the service re-checks the admin, the prerequisites and every recipient's eligibility. */
export async function sendCampaignNowAction(campaignId: unknown): Promise<CampaignActionResult<SendNowOutcome>> {
  const admin = await requireAdmin();
  try {
    const res = await adminSendCampaignNow(admin.id, campaignId);
    if (!res.ok) return failure(res);
    revalidatePath(LIST);
    revalidatePath(`${LIST}/${res.id}`);
    return { success: true, id: res.id, status: String(res.status), outcome: res.outcome, enqueued: res.enqueued, skipped: res.skipped, failed: res.failed, message: res.message, sent: res.delivery?.sent ?? 0, waiting: res.delivery?.waiting ?? 0 };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The campaign could not be sent. Please check its status before trying again.", "email-campaigns.send-now") };
  }
}

export type ContinueSendingOutcome = { id: string; status: string; enqueued: number; sent: number; waiting: number; message: string };

/** Continues a SENDING campaign: resumes queuing (bounded) and sends ONE more bounded batch, inside this request. Only the campaign id comes from the browser. */
export async function continueCampaignSendingAction(campaignId: unknown): Promise<CampaignActionResult<ContinueSendingOutcome>> {
  const admin = await requireAdmin();
  try {
    const res = await adminContinueCampaignSending(admin.id, campaignId);
    if (!res.ok) return failure(res);
    revalidatePath(LIST);
    revalidatePath(`${LIST}/${res.id}`);
    return { success: true, id: res.id, status: String(res.status), enqueued: res.enqueued, sent: res.delivery.sent, waiting: res.delivery.waiting, message: res.message };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The campaign could not be continued. Please check its status before trying again.", "email-campaigns.continue") };
  }
}

export async function unscheduleCampaignAction(campaignId: unknown): Promise<CampaignActionResult<TransitionOutcome>> {
  const admin = await requireAdmin();
  try {
    const res = await adminUnscheduleCampaign(admin.id, campaignId);
    if (!res.ok) return failure(res);
    revalidatePath(LIST);
    revalidatePath(`${LIST}/${res.id}`);
    return { success: true, id: res.id, status: res.status, scheduledAt: res.scheduledAt };
  } catch (error) {
    return { success: false, message: toUserMessage(error, GENERIC, "email-campaigns.unschedule") };
  }
}

export async function cancelCampaignAction(campaignId: unknown): Promise<CampaignActionResult<TransitionOutcome>> {
  const admin = await requireAdmin();
  try {
    const res = await adminCancelCampaign(admin.id, campaignId);
    if (!res.ok) return failure(res);
    revalidatePath(LIST);
    revalidatePath(`${LIST}/${res.id}`);
    return { success: true, id: res.id, status: res.status, scheduledAt: res.scheduledAt };
  } catch (error) {
    return { success: false, message: toUserMessage(error, GENERIC, "email-campaigns.cancel") };
  }
}
