/**
 * Shared, client-safe types and pure helpers for Email marketing > Campaigns (P12-UI-03). No database, no server-only imports.
 *
 * Which actions a campaign offers is DERIVED from the existing lifecycle (CAMPAIGN_TRANSITIONS, SENDER_ONLY_STATUSES, isCampaignEditable in
 * lib/email/campaign-rules). The UI adds no transition of its own: if the service would refuse a move, the button is not shown, and the service
 * still refuses it if someone calls the action anyway.
 */
import { canTransitionCampaign, isCampaignEditable, isCampaignStatus, SENDER_ONLY_STATUSES, type CampaignStatus } from "@/lib/email/campaign-rules";
import type { MarketingSkipReason } from "@/lib/email/marketing";
import type { FieldError } from "@/lib/email/template-rules";

export type { CampaignStatus, FieldError }; // re-exported so client components never import lib/email directly (the existing architecture guard)

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: "Draft", SCHEDULED: "Scheduled", SENDING: "Sending", COMPLETED: "Completed", CANCELLED: "Cancelled", FAILED: "Failed",
};
export const CAMPAIGN_STATUS_BADGE: Record<CampaignStatus, "secondary" | "accent" | "default" | "success" | "outline" | "destructive"> = {
  DRAFT: "secondary", SCHEDULED: "accent", SENDING: "default", COMPLETED: "success", CANCELLED: "outline", FAILED: "destructive",
};

export type CampaignAction = "edit_draft" | "send_now" | "unschedule" | "cancel";

/**
 * The actions a campaign in `status` may offer. "send_now" is offered for a DRAFT only (the same status the DRAFT -> SCHEDULED transition starts from) and
 * hands it to the existing dispatcher. "unschedule" remains only so a campaign scheduled BEFORE this change can be moved back to draft; nothing offers to schedule.
 */
export function campaignActionsFor(status: unknown): CampaignAction[] {
  if (!isCampaignStatus(status)) return [];
  const actions: CampaignAction[] = [];
  if (isCampaignEditable(status)) actions.push("edit_draft");
  if (canTransitionCampaign(status, "SCHEDULED") && !SENDER_ONLY_STATUSES.includes("SCHEDULED")) actions.push("send_now");
  if (canTransitionCampaign(status, "DRAFT")) actions.push("unschedule");
  if (canTransitionCampaign(status, "CANCELLED")) actions.push("cancel");
  return actions;
}

export const CAMPAIGNS_PAGE_SIZE = 20;
export const RECIPIENTS_PAGE_SIZE = 25;
export const RECIPIENT_STATUSES = ["PENDING", "QUEUED", "SENT", "FAILED", "SKIPPED"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];
export const isRecipientStatus = (v: unknown): v is RecipientStatus => typeof v === "string" && (RECIPIENT_STATUSES as readonly string[]).includes(v);

export const RECIPIENT_STATUS_LABEL: Record<RecipientStatus, string> = { PENDING: "Pending", QUEUED: "Queued", SENT: "Sent", FAILED: "Failed", SKIPPED: "Skipped" };

/** Plain-language labels for the fixed skip reasons (eligibility vocabulary) and the fixed delivery codes. Unknown codes are shown as written (they are lower-case codes, never a server reply). */
export const SKIP_REASON_LABEL: Record<MarketingSkipReason | string, string> = {
  invalid_email: "Invalid address",
  no_contact: "Contact no longer exists",
  suppressed: "Suppressed (unsubscribed, bounced, complained or blocked by an admin)",
  inactive: "Contact is inactive",
  no_consent: "No valid marketing consent",
  unverifiable: "Eligibility could not be verified",
  recipient_ineligible: "No longer eligible when the e-mail was due",
  campaign_not_active: "Campaign was no longer sending",
  recipient_not_queued: "Already settled",
  invalid_message: "Message was not valid for this recipient",
  job_missing: "Queued job no longer exists",
  unsubscribe_unavailable: "Unsubscribe link could not be created",
  unsubscribe_link_missing: "Unsubscribe link missing",
  recipient_missing: "Recipient record missing",
  campaign_closed: "Campaign was closed before sending",
};
export const reasonLabel = (code: string | null | undefined): string => (code ? SKIP_REASON_LABEL[code] ?? code.replace(/_/g, " ") : "—");

// ------------------------------------------------------------------------------------------------------------------------------------- views

export type CampaignListRow = {
  id: string; name: string; status: CampaignStatus; templateId: string | null; templateName: string | null; templateCategory: string | null; subject: string;
  scheduledAt: string | null; recipientCount: number; sentCount: number; failedCount: number; skippedCount: number; createdAt: string; updatedAt: string;
  actions: CampaignAction[];
};
export type CampaignStats = { total: number; byStatus: Record<CampaignStatus, number> };
export type CampaignListResult = { rows: CampaignListRow[]; total: number; page: number; pageCount: number; pageSize: number; q: string; status: CampaignStatus | null };

export type DeliveryBreakdown = { total: number; pending: number; queued: number; sent: number; failed: number; skipped: number; processed: number; percent: number };

export type RecipientRow = {
  id: string; contactId: string; email: string | null; name: string | null; status: RecipientStatus; reason: string | null;
  queuedAt: string | null; sentAt: string | null; updatedAt: string;
};
export type ReasonCount = { code: string; count: number };

export type CampaignDetail = {
  id: string; name: string; description: string | null; status: CampaignStatus; subject: string; senderName: string | null; senderEmail: string | null;
  scheduledAt: string | null; startedAt: string | null; completedAt: string | null; cancelledAt: string | null; createdAt: string; updatedAt: string;
  failureCode: string | null; hasUnsubscribeLink: boolean;
  template: { id: string; name: string; category: string; isActive: boolean } | null;
  delivery: DeliveryBreakdown; skipReasons: ReasonCount[]; failureCodes: ReasonCount[];
  actions: CampaignAction[];
  recipients: { rows: RecipientRow[]; total: number; page: number; pageCount: number; pageSize: number; status: RecipientStatus | null };
};

export type CampaignTemplateChoice = {
  id: string; name: string; category: string; subject: string; isDesigner: boolean; kind: "ready" | "draft" | "standard";
  eligible: boolean; reason: string | null;
};

export type AudienceSummary = {
  /** Recipient rows of the campaign (the snapshot). */
  total: number; eligible: number; skipped: number; queued: number; sent: number; failed: number;
  skipReasons: ReasonCount[];
};
export type AudiencePool = { total: number; eligible: number; eligibleChecked: boolean; unsubscribed: number; suppressed: number; inactive: number };

export type ReviewCheck = { id: string; label: string; ok: boolean; detail: string | null };
export type CampaignReview = {
  campaign: { id: string; name: string; description: string | null; status: CampaignStatus; senderName: string | null; senderEmail: string | null; scheduledAt: string | null; templateName: string | null; templateCategory: string | null };
  subject: string; html: string; text: string;
  audience: AudienceSummary;
  checks: ReviewCheck[];
  /** True when every check passed and the campaign is still a draft: sending may be attempted (the service re-checks all of it). */
  ready: boolean;
};

/**
 * Audience preparation is ADDITIVE (prepareCampaignRecipients never removes a recipient). Whenever a campaign already has recipient rows of ANY status
 * the wizard shows this warning, in the Audience step AND in Review & send (an admin may resume a draft directly there). Returns null when the
 * campaign has no recipient rows. Pure: the UI decides nothing about eligibility from it.
 */
export type AudienceAdditiveWarning = { title: string; points: string[] };
export function audienceAdditiveWarning(recipientRows: number): AudienceAdditiveWarning | null {
  if (!Number.isFinite(recipientRows) || recipientRows < 1) return null;
  return {
    title: "This campaign already has recipients, and they stay in it",
    points: [
      "Recipients already added to this campaign will remain in it.",
      'Switching from "All eligible contacts" to "Selected contacts" does NOT remove previously added recipients.',
      "The selected mode only controls which additional contacts may be added.",
      "If you need a smaller or different audience, create a new campaign before preparing that audience.",
    ],
  };
}
