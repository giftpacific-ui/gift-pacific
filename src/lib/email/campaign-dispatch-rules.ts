/**
 * Campaign dispatch rules (Prompt 10). PURE: no database, no network, no secrets. Decides which campaign states may be dispatched, builds the ONE
 * personalised message that goes into an EmailJob, and names the fixed codes the worker records when it does not send. Nothing here sends or queues.
 */
import { stripDesignMarker } from "@/lib/email/designer/marker";
import { renderEmailTemplate, scanPlaceholders, type FieldError } from "@/lib/email/template-rules";
import { emailDedupeKey, validateEmailJobInput, type EmailJobInput } from "@/lib/email/queue-policy";
import type { UnsubscribeUrl } from "@/lib/email/unsubscribe";
import { isUnsubscribeRoutePath } from "@/lib/email/unsubscribe-path";

/** The EmailJob `kind` label of every campaign e-mail. The worker only looks for a linked recipient for jobs with this kind. */
export const CAMPAIGN_JOB_KIND = "campaign";

/**
 * Fixed codes written to EmailJob.errorCode / EmailCampaignRecipient.errorCode when the worker deliberately does NOT send. They extend the same
 * free-text column the queue already fills with fixed codes (expired, attempts_exhausted, ...); no schema value is added.
 */
export const CAMPAIGN_SEND_BLOCK = {
  /** Eligibility changed after the e-mail was queued (the recipient row becomes SKIPPED with the eligibility reason). */
  ineligible: "recipient_ineligible",
  /** The campaign is no longer SENDING (cancelled meanwhile). */
  campaignNotActive: "campaign_not_active",
  /** The recipient row is not in the QUEUED state any more (already settled): sending again could only duplicate. */
  notQueued: "recipient_not_queued",
  /** The message built for this recipient is not a valid e-mail (for example the personalised subject became too long). */
  invalidMessage: "invalid_message",
  /** The recipient is QUEUED but its job no longer exists. */
  jobMissing: "job_missing",
  /** Prompt 11: a working unsubscribe URL could not be created for this recipient (secret/base URL unusable, token could not be stored). Nothing is sent. */
  unsubscribeUnavailable: "unsubscribe_unavailable",
  /** Prompt 11: the queued message does not contain this recipient's unsubscribe URL (for example it was queued before links existed). Nothing is sent. */
  unsubscribeMissing: "unsubscribe_link_missing",
  /** Prompt 11 follow-up: a "campaign" job has no matching campaign recipient row, so its recipient and unsubscribe link cannot be verified. Nothing is sent. */
  recipientMissing: "recipient_missing",
} as const;
export type CampaignSendBlock = (typeof CAMPAIGN_SEND_BLOCK)[keyof typeof CAMPAIGN_SEND_BLOCK];

const SAFE_CODE = /^[a-z][a-z0-9_]{0,39}$/;
/** An error code may be copied from a job to a recipient only when it is one of the fixed lower-case codes (never a raw server reply). */
export const safeErrorCode = (code: unknown): string | null => (typeof code === "string" && SAFE_CODE.test(code) ? code : null);

export type DispatchState = { ok: true; resumed: boolean } | { ok: false; reason: "invalid_status" | "not_due"; message: string };

/** SCHEDULED campaigns whose time has come start; SENDING campaigns resume (a partly finished dispatch). Nothing else is dispatchable. */
export function assessDispatchState(status: unknown, scheduledAt: Date | null, now: Date): DispatchState {
  if (status === "SENDING") return { ok: true, resumed: true };
  if (status === "SCHEDULED") {
    if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() > now.getTime()) {
      return { ok: false, reason: "not_due", message: "The campaign is scheduled for a later time." };
    }
    return { ok: true, resumed: false };
  }
  return { ok: false, reason: "invalid_status", message: `A ${String(status).toLowerCase()} campaign cannot be dispatched. Only a scheduled campaign that is due, or one that is already sending, can.` };
}

export const firstNameOf = (name: string | null | undefined): string => (typeof name === "string" ? name.trim().split(/\s+/)[0] ?? "" : "");

export type CampaignSnapshot = { subject: string; textBody: string; htmlBody: string | null };
export type MessageContact = { id: string; email: string; name: string | null };

export type CampaignMessage = { ok: true; input: EmailJobInput; dedupeKey: string } | { ok: false; errors: FieldError[] };

/**
 * Prompt 11: every campaign message MUST carry its recipient's unsubscribe URL. The campaign snapshot has to use {{unsubscribeUrl}} in the text body
 * and, when there is one, in the HTML body (a text-only or HTML-only reader must still find the link). It must NOT be in the subject: the subject is
 * kept on the job row after sending and shows up in notification previews. Returns the problems (empty = fine); nothing is rendered here.
 */
export function unsubscribePlaceholderProblems(snapshot: CampaignSnapshot): FieldError[] {
  const has = (text: string | null) => text !== null && scanPlaceholders(text).variables.includes("unsubscribeUrl");
  const problems: FieldError[] = [];
  if (has(snapshot.subject)) problems.push({ field: "subject", code: "unsubscribe_url_in_subject", message: "{{unsubscribeUrl}} must not be used in the subject." });
  if (!has(snapshot.textBody)) problems.push({ field: "textBody", code: "unsubscribe_link_missing", message: "The text body must contain {{unsubscribeUrl}}." });
  if (snapshot.htmlBody !== null && !has(snapshot.htmlBody)) problems.push({ field: "htmlBody", code: "unsubscribe_link_missing", message: "The HTML body must contain {{unsubscribeUrl}}." });
  return problems;
}

/**
 * The e-mail for ONE recipient: the campaign's own snapshot, personalised with fixed values only, as a valid queue input. The recipient's validated
 * unsubscribe URL is REQUIRED: without a snapshot that uses {{unsubscribeUrl}}, or if the rendered text/HTML does not contain exactly that URL, there is
 * no message (so nothing can be queued without a working link). The URL value is a branded type that only `validateUnsubscribeUrl` can produce.
 */
export function buildCampaignMessage(campaignId: string, recipientId: string, contact: MessageContact, rawSnapshot: CampaignSnapshot, storeName: string, unsubscribeUrl: UnsubscribeUrl): CampaignMessage {
  // P12-UI-02: the internal template-designer marker never goes into a customer e-mail, even if an older campaign snapshot still carries it.
  const snapshot: CampaignSnapshot = { ...rawSnapshot, htmlBody: stripDesignMarker(rawSnapshot.htmlBody) };
  const missing = (message: string): CampaignMessage => ({ ok: false, errors: [{ field: "unsubscribeUrl", code: "unsubscribe_link_missing", message }] });
  if (typeof unsubscribeUrl !== "string" || unsubscribeUrl === "") return missing("An unsubscribe URL is required.");
  // The brand is compile-time only, so re-check at runtime what this pure module can: it must be a URL whose path is the unsubscribe route + one token
  // (a link to any other page is refused). The origin and scheme rules are enforced where the URL is created (validateUnsubscribeUrl).
  let path: string | null = null;
  try { path = new URL(unsubscribeUrl).pathname; } catch { path = null; }
  if (!isUnsubscribeRoutePath(path)) return missing("The unsubscribe URL is not an unsubscribe link.");
  const placeholderProblems = unsubscribePlaceholderProblems(snapshot);
  if (placeholderProblems.length) return { ok: false, errors: placeholderProblems };
  const rendered = renderEmailTemplate(snapshot, { customerName: contact.name ?? "", firstName: firstNameOf(contact.name), email: contact.email, storeName, unsubscribeUrl });
  if (!rendered.ok) return rendered;
  if (!rendered.textBody.includes(unsubscribeUrl) || (rendered.htmlBody !== null && !rendered.htmlBody.includes(unsubscribeUrl))) return missing("The rendered message does not contain the unsubscribe URL.");
  const parts = [campaignId, recipientId];
  const input: EmailJobInput = { kind: CAMPAIGN_JOB_KIND, dedupeParts: parts, to: contact.email, subject: rendered.subject, text: rendered.textBody, html: rendered.htmlBody };
  const checked = validateEmailJobInput(input);
  if (!checked.ok) return { ok: false, errors: [{ field: "message", code: "invalid_message", message: checked.message }] };
  const key = emailDedupeKey(CAMPAIGN_JOB_KIND, parts);
  return key ? { ok: true, input, dedupeKey: key } : { ok: false, errors: [{ field: "message", code: "invalid_message", message: "No de-duplication key." }] };
}

export type DeliveryCounts = { total: number; pending: number; queued: number; sent: number; failed: number; skipped: number };

/** A campaign is finished when no recipient is waiting (PENDING) or in flight (QUEUED). Enqueueing alone never finishes it. */
export const isCampaignFinished = (counts: DeliveryCounts): boolean => counts.total > 0 && counts.pending === 0 && counts.queued === 0;
