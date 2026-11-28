import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  canTransitionCampaign, cleanCampaignDescription, cleanCampaignName, cleanSenderEmail, cleanSenderName, CAMPAIGN_CREATE_FIELDS, CAMPAIGN_STATUSES,
  isCampaignEditable, isCampaignStatus, SENDER_ONLY_STATUSES, unsupportedFields, validateScheduledAt, type CampaignStatus,
} from "@/lib/email/campaign-rules";
import { hasUnsubscribePlaceholder, isDesignerDraft, isDesignerTemplate, stripDesignMarker } from "@/lib/email/designer/design";
import { cleanSearch, cleanSubject, isRecordId, normalizePagination, validateTemplateContent, type FieldError } from "@/lib/email/template-rules";
import { unsubscribePlaceholderProblems } from "@/lib/email/campaign-dispatch-rules";
import { readUnsubscribeConfig, UNSUBSCRIBE_SECRET_ENV } from "@/lib/email/unsubscribe";

type Db = typeof prisma;

/**
 * E-mail campaign management (Prompt 09). Uses the existing EmailCampaign table and its status enum only. A campaign is created from a usable
 * template and keeps its OWN snapshot of subject and body, so later template edits or archiving never change it. Only a DRAFT can be edited.
 * This service never sends, queues EmailJobs, runs on a schedule or touches recipients (see email-campaign-recipient.service for the audience).
 * SCHEDULED is a recorded status here; the automated dispatcher (email-campaign-scheduler.service, Prompt 12) is what acts on it when the time arrives.
 *
 * Duplicate protection: the schema has no unique key on a campaign, so this is a service rule, not a constraint: an open (DRAFT, SCHEDULED or
 * SENDING) campaign with the same name is refused, serialised per name with an advisory lock so two racing creates cannot both pass the check.
 */

export type CampaignFailure =
  | { ok: false; reason: "invalid_input"; message: string; errors: FieldError[] }
  | {
      ok: false;
      reason: "not_found" | "template_not_found" | "template_archived" | "template_wrong_category" | "template_invalid" | "template_not_ready" | "duplicate_campaign" | "not_editable"
        | "invalid_transition" | "transition_reserved" | "no_recipients" | "status_conflict" | "unsubscribe_link_missing" | "unsubscribe_link_unavailable";
      message: string;
      errors?: FieldError[];
    };

export type EmailCampaignSummary = {
  id: string; name: string; status: CampaignStatus; templateId: string | null; subject: string; scheduledAt: Date | null;
  recipientCount: number; sentCount: number; failedCount: number; skippedCount: number; createdAt: Date; updatedAt: Date;
};
export type EmailCampaignView = EmailCampaignSummary & {
  description: string | null; textBody: string; htmlBody: string | null; senderName: string | null; senderEmail: string | null;
  startedAt: Date | null; completedAt: Date | null; cancelledAt: Date | null; failureReason: string | null;
};

type Row = {
  id: string; name: string; description: string | null; status: string; templateId: string | null; subject: string; textBody: string; htmlBody: string | null;
  senderName: string | null; senderEmail: string | null; scheduledAt: Date | null; startedAt: Date | null; completedAt: Date | null; cancelledAt: Date | null;
  failureReason: string | null; recipientCount: number; sentCount: number; failedCount: number; skippedCount: number; createdAt: Date; updatedAt: Date;
};

const toSummary = (r: Row): EmailCampaignSummary => ({
  id: r.id, name: r.name, status: r.status as CampaignStatus, templateId: r.templateId, subject: r.subject, scheduledAt: r.scheduledAt,
  recipientCount: r.recipientCount, sentCount: r.sentCount, failedCount: r.failedCount, skippedCount: r.skippedCount, createdAt: r.createdAt, updatedAt: r.updatedAt,
});
const toView = (r: Row): EmailCampaignView => ({
  ...toSummary(r), description: r.description, textBody: r.textBody, htmlBody: r.htmlBody, senderName: r.senderName, senderEmail: r.senderEmail,
  startedAt: r.startedAt, completedAt: r.completedAt, cancelledAt: r.cancelledAt, failureReason: r.failureReason,
});

const invalid = (errors: FieldError[]): CampaignFailure => ({ ok: false, reason: "invalid_input", message: errors[0]?.message ?? "Invalid input.", errors });
const fail = (reason: Exclude<CampaignFailure["reason"], "invalid_input">, message: string, errors?: FieldError[]): CampaignFailure => ({ ok: false, reason, message, ...(errors ? { errors } : {}) });
const NOT_FOUND = fail("not_found", "Campaign not found.");
const asObject = (input: unknown): Record<string, unknown> | null => (input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null);
const OPEN: CampaignStatus[] = ["DRAFT", "SCHEDULED", "SENDING"];

type TemplateRow = { id: string; category: string; subject: string; textBody: string; htmlBody: string | null; isActive: boolean };

/** A template is usable for a campaign when it exists, is not archived, is not a RECOVERY template, and its stored content still validates. Exported (P12-UI-03) so the campaign wizard shows exactly the verdict that createEmailCampaign enforces. */
export function assessTemplate(t: TemplateRow | null): { ok: true; template: TemplateRow } | CampaignFailure {
  if (!t) return fail("template_not_found", "The selected template does not exist.");
  if (!t.isActive) return fail("template_archived", "The selected template is archived and cannot be used for a campaign.");
  if (t.category === "RECOVERY") return fail("template_wrong_category", "Recovery templates are not used for campaigns.");
  const content = validateTemplateContent(t);
  if (!content.ok) return fail("template_invalid", "The selected template has invalid content.", content.errors);
  // P12-UI-02: a template made in the template designer is usable only once it is marked ready and still carries {{unsubscribeUrl}}. Templates made
  // any other way carry no designer marker and are judged exactly as before.
  if (isDesignerDraft(t.htmlBody)) return fail("template_not_ready", "The selected template is still a draft in the template designer. Mark it ready before using it for a campaign.");
  if (isDesignerTemplate(t.htmlBody) && !hasUnsubscribePlaceholder(t)) return fail("template_not_ready", "The selected template has no unsubscribe link ({{unsubscribeUrl}}), so it cannot be used for a campaign.");
  return { ok: true, template: t };
}

/** Subject for the snapshot: an override (validated, placeholders checked) or the template's own. */
function resolveSubject(override: unknown, template: TemplateRow): { ok: true; subject: string } | CampaignFailure {
  if (override === undefined || override === null || (typeof override === "string" && !override.trim())) return { ok: true, subject: template.subject };
  const s = cleanSubject(override);
  if (!s.ok) return invalid([s.error]);
  const checked = validateTemplateContent({ subject: s.value, textBody: template.textBody });
  if (!checked.ok) {
    const subjectErrors = checked.errors.filter((e) => e.field === "subject");
    if (subjectErrors.length) return invalid(subjectErrors);
  }
  return { ok: true, subject: s.value as string };
}

async function lockName(tx: Prisma.TransactionClient, name: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`emailcampaign-name:${name}`}))`;
}
async function openDuplicate(tx: Prisma.TransactionClient, name: string, exceptId?: string) {
  const where: Prisma.EmailCampaignWhereInput = { name, status: { in: OPEN } };
  if (exceptId) where.id = { not: exceptId };
  return tx.emailCampaign.findFirst({ where, select: { id: true } });
}
const DUPLICATE = fail("duplicate_campaign", "An open campaign with this name already exists.");

export type CreateEmailCampaignInput = { name?: unknown; description?: unknown; templateId?: unknown; subject?: unknown; senderName?: unknown; senderEmail?: unknown };

/** Creates a DRAFT campaign from a usable template (snapshotting its subject and bodies). `subject` overrides the template's subject. */
export async function createEmailCampaign(
  input: unknown,
  opts: { db?: Db; actorId?: string | null } = {},
): Promise<{ ok: true; campaign: EmailCampaignView } | CampaignFailure> {
  const obj = asObject(input);
  if (!obj) return invalid([{ field: "input", code: "invalid_type", message: "Campaign details are required." }]);
  const errors = unsupportedFields(obj, CAMPAIGN_CREATE_FIELDS);
  const name = cleanCampaignName(obj.name);
  if (!name.ok) errors.push(name.error);
  const description = cleanCampaignDescription(obj.description);
  if (!description.ok) errors.push(description.error);
  const senderName = cleanSenderName(obj.senderName);
  if (!senderName.ok) errors.push(senderName.error);
  const senderEmail = cleanSenderEmail(obj.senderEmail);
  if (!senderEmail.ok) errors.push(senderEmail.error);
  if (!isRecordId(obj.templateId)) errors.push({ field: "templateId", code: "required", message: "Choose a template." });
  if (errors.length || !name.ok || !description.ok || !senderName.ok || !senderEmail.ok) return invalid(errors);
  const templateId = obj.templateId as string;

  return (opts.db ?? prisma).$transaction(async (tx: Prisma.TransactionClient) => {
    const assessed = assessTemplate(await tx.emailTemplate.findUnique({ where: { id: templateId } }));
    if (!assessed.ok) return assessed;
    const subject = resolveSubject(obj.subject, assessed.template);
    if (!subject.ok) return subject;
    await lockName(tx, name.value as string);
    if (await openDuplicate(tx, name.value as string)) return DUPLICATE;
    const row = await tx.emailCampaign.create({
      data: {
        name: name.value as string, description: description.value, status: "DRAFT", templateId, subject: subject.subject, textBody: assessed.template.textBody,
        htmlBody: stripDesignMarker(assessed.template.htmlBody), senderName: senderName.value, senderEmail: senderEmail.value, createdById: opts.actorId ?? null,
      },
    });
    return { ok: true, campaign: toView(row as Row) } as const;
  });
}

/**
 * Updates a DRAFT campaign: name, description, subject (null/blank = back to the template's subject), sender, or a different template (which takes a
 * fresh snapshot; its subject is used unless `subject` is given in the same call). Status, schedule, counts and ownership cannot be set here.
 * The write itself requires status = DRAFT, so a campaign scheduled or cancelled in the meantime is never overwritten.
 */
export async function updateEmailCampaign(
  id: unknown,
  patch: unknown,
  opts: { db?: Db } = {},
): Promise<{ ok: true; campaign: EmailCampaignView; changed: boolean } | CampaignFailure> {
  if (!isRecordId(id)) return NOT_FOUND;
  const obj = asObject(patch);
  if (!obj) return invalid([{ field: "input", code: "invalid_type", message: "Campaign changes are required." }]);
  const errors = unsupportedFields(obj, CAMPAIGN_CREATE_FIELDS);
  if (!CAMPAIGN_CREATE_FIELDS.some((f) => obj[f] !== undefined)) errors.push({ field: "input", code: "empty", message: "Nothing to change." });
  const name = obj.name !== undefined ? cleanCampaignName(obj.name) : null;
  if (name && !name.ok) errors.push(name.error);
  const description = obj.description !== undefined ? cleanCampaignDescription(obj.description) : null;
  if (description && !description.ok) errors.push(description.error);
  const senderName = obj.senderName !== undefined ? cleanSenderName(obj.senderName) : null;
  if (senderName && !senderName.ok) errors.push(senderName.error);
  const senderEmail = obj.senderEmail !== undefined ? cleanSenderEmail(obj.senderEmail) : null;
  if (senderEmail && !senderEmail.ok) errors.push(senderEmail.error);
  if (obj.templateId !== undefined && !isRecordId(obj.templateId)) errors.push({ field: "templateId", code: "invalid", message: "Choose a template." });
  if (errors.length) return invalid(errors);

  return (opts.db ?? prisma).$transaction(async (tx: Prisma.TransactionClient) => {
    const current = await tx.emailCampaign.findUnique({ where: { id } });
    if (!current) return NOT_FOUND;
    if (!isCampaignEditable(current.status)) return fail("not_editable", `A ${String(current.status).toLowerCase()} campaign cannot be edited.`);

    const data: Prisma.EmailCampaignUpdateManyMutationInput = {};
    const newName = name && name.ok ? (name.value as string) : null;
    if (newName !== null && newName !== current.name) {
      await lockName(tx, newName);
      if (await openDuplicate(tx, newName, id)) return DUPLICATE;
      data.name = newName;
    }
    if (description && description.ok && description.value !== current.description) data.description = description.value;
    if (senderName && senderName.ok && senderName.value !== current.senderName) data.senderName = senderName.value;
    if (senderEmail && senderEmail.ok && senderEmail.value !== current.senderEmail) data.senderEmail = senderEmail.value;

    const templateChanged = obj.templateId !== undefined && obj.templateId !== current.templateId;
    if (templateChanged || obj.subject !== undefined) {
      const templateId = (templateChanged ? obj.templateId : current.templateId) as string | null;
      const assessed = assessTemplate(templateId ? await tx.emailTemplate.findUnique({ where: { id: templateId } }) : null);
      if (!assessed.ok) return assessed;
      const subject = resolveSubject(obj.subject, assessed.template);
      if (!subject.ok) return subject;
      if (subject.subject !== current.subject) data.subject = subject.subject;
      if (templateChanged) Object.assign(data, { templateId: assessed.template.id, textBody: assessed.template.textBody, htmlBody: stripDesignMarker(assessed.template.htmlBody) });
    }

    if (!Object.keys(data).length) return { ok: true, campaign: toView(current as Row), changed: false } as const;
    const res = await tx.emailCampaign.updateMany({ where: { id, status: "DRAFT" }, data });
    if (res.count === 0) return fail("not_editable", "This campaign is no longer a draft and cannot be edited.");
    return { ok: true, campaign: toView((await tx.emailCampaign.findUnique({ where: { id } })) as Row), changed: true } as const;
  });
}

export async function getEmailCampaign(id: unknown, opts: { db?: Db } = {}): Promise<{ ok: true; campaign: EmailCampaignView } | CampaignFailure> {
  if (!isRecordId(id)) return NOT_FOUND;
  const row = await (opts.db ?? prisma).emailCampaign.findUnique({ where: { id } });
  return row ? { ok: true, campaign: toView(row as Row) } : NOT_FOUND;
}

export type ListEmailCampaignsInput = { page?: unknown; pageSize?: unknown; status?: unknown; templateId?: unknown; search?: unknown };
export type EmailCampaignList = { ok: true; items: EmailCampaignSummary[]; total: number; page: number; pageSize: number; totalPages: number };

/** Newest first, paginated; filter by status, template and name text. Bodies and sender details are not included (use get). */
export async function listEmailCampaigns(input: ListEmailCampaignsInput = {}, opts: { db?: Db } = {}): Promise<EmailCampaignList | CampaignFailure> {
  const errors: FieldError[] = [];
  const paging = normalizePagination(input);
  if (!paging.ok) errors.push(...paging.errors);
  if (input.status !== undefined && !isCampaignStatus(input.status)) errors.push({ field: "status", code: "invalid_status", message: `Status must be one of: ${CAMPAIGN_STATUSES.join(", ")}.` });
  if (input.templateId !== undefined && !isRecordId(input.templateId)) errors.push({ field: "templateId", code: "invalid", message: "templateId is not valid." });
  const search = cleanSearch(input.search);
  if (!search.ok) errors.push(...search.errors);
  if (errors.length || !paging.ok || !search.ok) return invalid(errors);

  const where: Prisma.EmailCampaignWhereInput = {};
  if (input.status !== undefined) where.status = input.status as CampaignStatus;
  if (input.templateId !== undefined) where.templateId = input.templateId as string;
  if (search.value) where.name = { contains: search.value, mode: "insensitive" };
  const db = opts.db ?? prisma;
  const [rows, total] = await Promise.all([
    db.emailCampaign.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: paging.skip, take: paging.pageSize }),
    db.emailCampaign.count({ where }),
  ]);
  return { ok: true, items: (rows as Row[]).map(toSummary), total, page: paging.page, pageSize: paging.pageSize, totalPages: Math.max(1, Math.ceil(total / paging.pageSize)) };
}

/**
 * Everything a campaign needs BEFORE the dispatcher may be given it, shared by "schedule" and "send now" so the two can never drift apart: a prepared
 * audience (stored count AND real PENDING rows), valid content, the P11 unsubscribe placeholder rules and a usable unsubscribe secret / public base URL.
 * Read-only. Returns the first refusal, or null when the campaign may go on. The dispatcher re-checks all of it (and every recipient's eligibility) itself.
 */
async function assessSendPrerequisites(db: Db, current: Row, env: Record<string, string | undefined>, verb: "scheduling" | "sending"): Promise<CampaignFailure | null> {
  if (current.recipientCount < 1) return fail("no_recipients", `Prepare the campaign audience before ${verb} it.`);
  const content = validateTemplateContent(current);
  if (!content.ok) return fail("template_invalid", "The campaign content is not valid.", content.errors);
  // The audience must really be there (rows, not just the stored count) ...
  if ((await db.emailCampaignRecipient.count({ where: { campaignId: current.id, status: "PENDING" } })) < 1) return fail("no_recipients", `Prepare the campaign audience before ${verb} it.`);
  // ... and the P11 unsubscribe prerequisites must hold now, exactly as the dispatcher will require them.
  const linkProblems = unsubscribePlaceholderProblems({ subject: content.value.subject, textBody: content.value.textBody, htmlBody: content.value.htmlBody });
  if (linkProblems.length) return fail("unsubscribe_link_missing", "A campaign must contain {{unsubscribeUrl}} (in the text body and, if present, the HTML body) and not in the subject.", linkProblems);
  const unsubscribe = readUnsubscribeConfig(env);
  if (!unsubscribe.ok) {
    const what = unsubscribe.reason === "base_url_invalid" ? "NEXT_PUBLIC_APP_URL is not a valid public https address" : `${UNSUBSCRIBE_SECRET_ENV} is not set to a strong dedicated secret`;
    return fail("unsubscribe_link_unavailable", `Unsubscribe links cannot be created: ${what}. The campaign was not ${verb === "scheduling" ? "scheduled" : "sent"}.`);
  }
  return null;
}

/**
 * Moves a campaign along CAMPAIGN_TRANSITIONS, performing only the moves that are not sending: DRAFT -> SCHEDULED (needs a future `scheduledAt`, a
 * prepared audience and valid content), SCHEDULED -> DRAFT (clears the time) and DRAFT/SCHEDULED -> CANCELLED. SENDING, COMPLETED and FAILED belong
 * to the sender (a later prompt) and are refused as "transition_reserved". The write requires the status that was read, so two racing changes
 * cannot both apply ("status_conflict"). Recording SCHEDULED does not start anything itself.
 *
 * Prompt 12: SCHEDULED is only recorded for a campaign that the dispatcher could actually send. Every check below runs HERE, on the server, BEFORE the
 * single conditional write, so a refusal leaves the campaign exactly as it was (still DRAFT, with no time set). Besides the P09 checks (future time,
 * prepared audience, valid content) a campaign needs the P11 unsubscribe prerequisites the dispatcher will demand later: {{unsubscribeUrl}} in the text
 * body and in the HTML body when there is one (never in the subject), the dedicated secret, and a valid public base URL for this environment. The
 * dispatcher re-checks all of it at send time; scheduling it earlier only means a misconfigured campaign is refused up front instead of failing when due.
 */
export async function transitionEmailCampaignStatus(
  id: unknown,
  to: unknown,
  opts: { db?: Db; now?: Date; scheduledAt?: unknown; /** Where the unsubscribe secret and base URL are read from (default process.env). */ unsubscribeEnv?: Record<string, string | undefined> } = {},
): Promise<{ ok: true; campaign: EmailCampaignView } | CampaignFailure> {
  if (!isRecordId(id)) return NOT_FOUND;
  if (!isCampaignStatus(to)) return invalid([{ field: "status", code: "invalid_status", message: `Status must be one of: ${CAMPAIGN_STATUSES.join(", ")}.` }]);
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const current = await db.emailCampaign.findUnique({ where: { id } });
  if (!current) return NOT_FOUND;
  const from = current.status as CampaignStatus;
  if (!isCampaignStatus(from) || !canTransitionCampaign(from, to)) return fail("invalid_transition", `A ${String(from).toLowerCase()} campaign cannot become ${to.toLowerCase()}.`);
  if (SENDER_ONLY_STATUSES.includes(to)) return fail("transition_reserved", `${to} is set by campaign sending, not here.`);

  const data: Prisma.EmailCampaignUpdateManyMutationInput = { status: to };
  if (to === "SCHEDULED") {
    const when = validateScheduledAt(opts.scheduledAt, now);
    if (!when.ok) return invalid([when.error]);
    const blocked = await assessSendPrerequisites(db, current as Row, opts.unsubscribeEnv ?? process.env, "scheduling");
    if (blocked) return blocked;
    data.scheduledAt = when.value;
  } else if (to === "DRAFT") data.scheduledAt = null;
  else if (to === "CANCELLED") data.cancelledAt = now;

  const res = await db.emailCampaign.updateMany({ where: { id, status: from }, data });
  if (res.count === 0) return fail("status_conflict", "The campaign was changed by someone else. Reload and try again.");
  return { ok: true, campaign: toView((await db.emailCampaign.findUnique({ where: { id } })) as Row) };
}

/**
 * Immediate send, step 1 (P12 UX change): moves a DRAFT to SCHEDULED with scheduledAt = now, in ONE conditional write, after the very same checks
 * that scheduling needs (assessSendPrerequisites). It does NOT send, queue or choose recipients: the caller then hands the campaign to the EXISTING
 * dispatchEmailCampaign, which re-checks every recipient's consent / suppression, creates the EmailJobs with their dedupe keys and lets the existing
 * worker send. Nothing is invented here: DRAFT -> SCHEDULED is an existing public transition, "scheduled for now" is simply already due, and the
 * existing dispatcher (and the cron safety net that resumes an interrupted campaign) handle it like any other due campaign.
 * Only a DRAFT can start (a second click, a campaign that is already scheduled, sending, cancelled or finished is refused); the write requires status
 * DRAFT, so two racing clicks cannot both win ("status_conflict"). No future time is ever chosen by a caller: `now` is the only instant used.
 */
export async function startEmailCampaignNow(
  id: unknown,
  opts: { db?: Db; now?: Date; unsubscribeEnv?: Record<string, string | undefined> } = {},
): Promise<{ ok: true; campaign: EmailCampaignView } | CampaignFailure> {
  if (!isRecordId(id)) return NOT_FOUND;
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const current = await db.emailCampaign.findUnique({ where: { id } });
  if (!current) return NOT_FOUND;
  const from = current.status as CampaignStatus;
  if (from !== "DRAFT" || !canTransitionCampaign(from, "SCHEDULED")) return fail("invalid_transition", `A ${String(from).toLowerCase()} campaign cannot be sent. Only a draft campaign can.`);
  const blocked = await assessSendPrerequisites(db, current as Row, opts.unsubscribeEnv ?? process.env, "sending");
  if (blocked) return blocked;
  const res = await db.emailCampaign.updateMany({ where: { id, status: "DRAFT" }, data: { status: "SCHEDULED", scheduledAt: now } });
  if (res.count === 0) return fail("status_conflict", "The campaign was changed by someone else. Reload and try again.");
  return { ok: true, campaign: toView((await db.emailCampaign.findUnique({ where: { id } })) as Row) };
}
