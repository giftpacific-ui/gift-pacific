import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { logServerInfo } from "@/lib/logger";
import { CAMPAIGN_STATUSES, isCampaignStatus, type CampaignStatus } from "@/lib/email/campaign-rules";
import { safeErrorCode, unsubscribePlaceholderProblems } from "@/lib/email/campaign-dispatch-rules";
import { readUnsubscribeBaseUrl } from "@/lib/email/unsubscribe-config";
import { readUnsubscribeConfig, UNSUBSCRIBE_SECRET_ENV } from "@/lib/email/unsubscribe";
import { stripDesignMarker, isDesignerDraft, isDesignerTemplate } from "@/lib/email/designer/design";
import { cleanSearch, isRecordId, renderEmailTemplate, validateTemplateContent, type FieldError } from "@/lib/email/template-rules";
import {
  campaignActionsFor, CAMPAIGNS_PAGE_SIZE, isRecipientStatus, RECIPIENTS_PAGE_SIZE,
  type AudiencePool, type AudienceSummary, type CampaignDetail, type CampaignListResult, type CampaignReview, type CampaignStats, type CampaignTemplateChoice,
  type DeliveryBreakdown, type ReasonCount, type RecipientRow, type RecipientStatus, type ReviewCheck,
} from "@/lib/email-campaigns";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";
import {
  assessTemplate, createEmailCampaign, getEmailCampaign, listEmailCampaigns, startEmailCampaignNow, transitionEmailCampaignStatus, updateEmailCampaign, type CampaignFailure,
} from "@/server/services/email-campaign.service";
import { dispatchEmailCampaign, type DispatchProgress } from "@/server/services/email-campaign-dispatch.service";
import { prepareCampaignRecipients, type PrepareRecipientsResult } from "@/server/services/email-campaign-recipient.service";
import { adminGetEmailContactStats, adminListEmailContacts } from "@/server/services/email-contact-admin.service";
import { describeManualRun, runEmailQueueNow, type ManualRunReport } from "@/server/services/email-manual-run.service";
import { EMAIL_JOB_MAX_ATTEMPTS, EMAIL_MANUAL_DISPATCH_DEADLINE_MS, EMAIL_MANUAL_MAX_JOBS } from "@/lib/email/queue-policy";

type Db = typeof prisma;
type Tx = Parameters<typeof assertAdminActor>[0];
type Env = Record<string, string | undefined>;
type Opts = { db?: Db; now?: Date; env?: Env };

/**
 * Admin side of Email marketing > Campaigns (P12-UI-03). A THIN layer: it adds the admin check, read models for the list / detail / review pages and
 * a few audit records. Everything that matters is the EXISTING code:
 *   - creating and editing a draft ........ createEmailCampaign / updateEmailCampaign (name, sender, template and subject rules, duplicate-name guard)
 *   - template eligibility ................ assessTemplate (the exact check createEmailCampaign enforces: draft designer templates stay blocked)
 *   - the audience ........................ prepareCampaignRecipients (every contact judged by getMarketingEligibility; this file never decides eligibility)
 *   - sending now, un-scheduling (legacy), cancelling  startEmailCampaignNow / transitionEmailCampaignStatus (prepared audience, valid content, unsubscribe prerequisites)
 *   - delivery ............................ the EXISTING dispatchEmailCampaign -> EmailJob queue -> SMTP worker (POST /api/email/queue). "Send now" (P12 UX change) only
 *     hands a DRAFT to that same dispatcher right away instead of waiting for a schedule; the cron-driven dispatchDueCampaigns stays as the safety net that
 *     resumes an interrupted campaign. There is no second queue, no SMTP code and no browser-side sending.
 * Nothing here sends mail itself, creates an EmailJob directly, writes consent or suppression, or touches an unsubscribe token. Counts shown come from the database,
 * never from the browser. Every operation re-checks that the actor is an ACTIVE ADMIN before any lookup or write.
 */

export type CampaignAdminFailure = { ok: false; code: string; message: string; errors?: FieldError[] };
const fail = (code: string, message: string, errors?: FieldError[]): CampaignAdminFailure => ({ ok: false, code, message, ...(errors ? { errors } : {}) });
const FORBIDDEN = fail("forbidden", "You are not authorised to do this.");
const NOT_FOUND = fail("not_found", "Campaign not found.");

async function admin(db: Db, adminId: unknown): Promise<string | null> {
  try { return await assertAdminActor(db as unknown as Tx, typeof adminId === "string" ? adminId : null); } catch { return null; }
}
const requireAdminOrThrow = async (db: Db, adminId: unknown) => {
  if (!(await admin(db, adminId))) throw new UserFacingError("You are not authorised to do this.");
};
const audit = (db: Db, actorId: string, action: string, entityId: string | null, detail: Record<string, unknown>) =>
  recordAudit(db as unknown as Parameters<typeof recordAudit>[0], { actorId, action, entityType: "EmailCampaign", entityId, detail }).catch(() => undefined);
const fromCampaignFailure = (f: CampaignFailure): CampaignAdminFailure => fail(f.reason, f.message, f.errors);
const iso = (d: Date | null | undefined) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);
const isoOr = (d: Date | null | undefined) => iso(d) ?? new Date(0).toISOString(); // createdAt/updatedAt always exist in the database; never let one odd row break a page
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// ------------------------------------------------------------------------------------------------------------------------------------ stats + list

export async function adminGetCampaignStats(adminId: unknown, opts: Opts = {}): Promise<CampaignStats> {
  const db = opts.db ?? prisma;
  await requireAdminOrThrow(db, adminId);
  const counts = await Promise.all(CAMPAIGN_STATUSES.map((status) => db.emailCampaign.count({ where: { status } })));
  const byStatus = Object.fromEntries(CAMPAIGN_STATUSES.map((s, i) => [s, counts[i]])) as Record<CampaignStatus, number>;
  return { total: counts.reduce((a, b) => a + b, 0), byStatus };
}

/** Newest first. Uses listEmailCampaigns (existing validation of page, status and search); adds the template's name. */
export async function adminListCampaigns(adminId: unknown, input: { q?: unknown; status?: unknown; page?: unknown }, opts: Opts = {}): Promise<CampaignListResult> {
  const db = opts.db ?? prisma;
  await requireAdminOrThrow(db, adminId);
  const search = cleanSearch(typeof input.q === "string" ? input.q : undefined);
  const q = search.ok && search.value ? search.value : "";
  const status = isCampaignStatus(input.status) ? input.status : null;
  const pageNum = Number(input.page);
  const page = Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= 100_000 ? pageNum : 1;

  const res = await listEmailCampaigns({ page, pageSize: CAMPAIGNS_PAGE_SIZE, ...(status ? { status } : {}), ...(q ? { search: q } : {}) }, { db });
  if (!res.ok) return { rows: [], total: 0, page: 1, pageCount: 1, pageSize: CAMPAIGNS_PAGE_SIZE, q, status };

  const templateIds = [...new Set(res.items.map((c) => c.templateId).filter((t): t is string => !!t))];
  const templates = templateIds.length ? await db.emailTemplate.findMany({ where: { id: { in: templateIds } }, select: { id: true, name: true, category: true } }) : [];
  const byId = new Map(templates.map((t) => [t.id, t]));
  return {
    rows: res.items.map((c) => ({
      id: c.id, name: c.name, status: c.status, templateId: c.templateId, templateName: c.templateId ? byId.get(c.templateId)?.name ?? null : null,
      templateCategory: c.templateId ? (byId.get(c.templateId)?.category as string | undefined) ?? null : null, subject: c.subject, scheduledAt: iso(c.scheduledAt),
      recipientCount: c.recipientCount, sentCount: c.sentCount, failedCount: c.failedCount, skippedCount: c.skippedCount, createdAt: isoOr(c.createdAt), updatedAt: isoOr(c.updatedAt),
      actions: campaignActionsFor(c.status),
    })),
    total: res.total, page: res.page, pageCount: res.totalPages, pageSize: res.pageSize, q, status,
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------ templates

/**
 * The templates the wizard shows. Eligibility is the verdict of the existing assessTemplate (archived, recovery, invalid content, designer drafts and
 * designer templates without {{unsubscribeUrl}} are refused there). Ineligible templates are listed with the reason so the admin understands why they
 * cannot be chosen; createEmailCampaign enforces the same rule again when the campaign is saved.
 */
export async function adminListCampaignTemplates(adminId: unknown, opts: Opts = {}): Promise<CampaignTemplateChoice[]> {
  const db = opts.db ?? prisma;
  await requireAdminOrThrow(db, adminId);
  const rows = await db.emailTemplate.findMany({ where: { isActive: true, category: { not: "RECOVERY" } }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100 });
  return rows.map((t) => {
    const verdict = assessTemplate(t as never);
    const isDesigner = isDesignerTemplate(t.htmlBody);
    return {
      id: t.id, name: t.name, category: String(t.category), subject: t.subject, isDesigner,
      kind: isDesignerDraft(t.htmlBody) ? "draft" : isDesigner ? "ready" : "standard",
      eligible: verdict.ok, reason: verdict.ok ? null : verdict.message,
    } satisfies CampaignTemplateChoice;
  });
}

// ------------------------------------------------------------------------------------------------------------------------------------ draft save

/**
 * Creates the DRAFT campaign, or updates it when `campaignId` is given. Only the fields the existing service accepts are passed on (status, schedule,
 * counts and ownership can never be set from here). The template's eligibility, the name / sender rules and the duplicate-name guard are the service's.
 */
export async function adminSaveCampaignDraft(adminId: unknown, input: unknown, opts: Opts = {}): Promise<{ ok: true; id: string; created: boolean; subject: string } | CampaignAdminFailure> {
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  const body = obj(input);
  if (!body) return fail("invalid_input", "Campaign details are required.");
  const fields: Record<string, unknown> = {};
  for (const k of ["name", "description", "templateId", "subject", "senderName", "senderEmail"] as const) if (body[k] !== undefined) fields[k] = body[k];

  if (body.campaignId !== undefined && body.campaignId !== null && body.campaignId !== "") {
    if (!isRecordId(body.campaignId)) return NOT_FOUND;
    const res = await updateEmailCampaign(body.campaignId, fields, { db });
    if (!res.ok) return fromCampaignFailure(res);
    if (res.changed) await audit(db, actor, "email_campaign.update", res.campaign.id, { templateId: res.campaign.templateId });
    return { ok: true, id: res.campaign.id, created: false, subject: res.campaign.subject };
  }
  const res = await createEmailCampaign(fields, { db, actorId: actor });
  if (!res.ok) return fromCampaignFailure(res);
  await audit(db, actor, "email_campaign.create", res.campaign.id, { templateId: res.campaign.templateId });
  return { ok: true, id: res.campaign.id, created: true, subject: res.campaign.subject };
}

/** A draft campaign as the wizard needs it to resume (details, chosen template and audience). */
export async function adminGetCampaignDraftForWizard(adminId: unknown, id: unknown, opts: Opts = {}): Promise<
  { ok: true; campaign: { id: string; name: string; description: string; senderName: string; senderEmail: string; templateId: string | null; subject: string }; audience: AudienceSummary } | CampaignAdminFailure
> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) return FORBIDDEN;
  const got = await getEmailCampaign(id, { db });
  if (!got.ok) return NOT_FOUND;
  const c = got.campaign;
  if (c.status !== "DRAFT") return fail("not_editable", `A ${c.status.toLowerCase()} campaign cannot be edited.`);
  return {
    ok: true,
    campaign: { id: c.id, name: c.name, description: c.description ?? "", senderName: c.senderName ?? "", senderEmail: c.senderEmail ?? "", templateId: c.templateId, subject: c.subject },
    audience: await audienceSummary(db, c.id),
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------ audience

const reasonCounts = (rows: { key: string | null; n: number }[]): ReasonCount[] =>
  rows.map((r) => ({ code: safeErrorCode(r.key) ?? "other", count: r.n })).reduce<ReasonCount[]>((acc, r) => {
    const hit = acc.find((x) => x.code === r.code);
    if (hit) hit.count += r.count; else acc.push({ ...r });
    return acc;
  }, []).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

async function audienceSummary(db: Db, campaignId: string): Promise<AudienceSummary> {
  const groups = (await db.emailCampaignRecipient.groupBy({ by: ["status", "skipReason"], where: { campaignId }, _count: { _all: true } })) as unknown as { status: string; skipReason: string | null; _count: { _all: number } }[];
  const n = (s: string) => groups.filter((g) => g.status === s).reduce((a, g) => a + g._count._all, 0);
  return {
    total: groups.reduce((a, g) => a + g._count._all, 0), eligible: n("PENDING"), skipped: n("SKIPPED"), queued: n("QUEUED"), sent: n("SENT"), failed: n("FAILED"),
    skipReasons: reasonCounts(groups.filter((g) => g.status === "SKIPPED").map((g) => ({ key: g.skipReason, n: g._count._all }))),
  };
}

/** The contact pool today (existing contact statistics: eligibility is judged by getMarketingEligibility) plus this campaign's prepared audience. */
export async function adminGetAudienceOverview(adminId: unknown, campaignId: unknown, opts: Opts = {}): Promise<{ ok: true; pool: AudiencePool; audience: AudienceSummary } | CampaignAdminFailure> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) return FORBIDDEN;
  if (!isRecordId(campaignId)) return NOT_FOUND;
  const exists = await db.emailCampaign.findUnique({ where: { id: campaignId }, select: { id: true } });
  if (!exists) return NOT_FOUND;
  const stats = await adminGetEmailContactStats(adminId, { db, now: opts.now });
  return { ok: true, pool: { total: stats.total, eligible: stats.eligible, eligibleChecked: stats.eligibleChecked, unsubscribed: stats.unsubscribed, suppressed: stats.suppressed, inactive: stats.inactive }, audience: await audienceSummary(db, campaignId) };
}

const MAX_PICKED_CONTACTS = 500;

/**
 * Prepares (or refreshes) the audience with the EXISTING prepareCampaignRecipients. `contactIds` (optional) limits it to chosen contacts; without it every
 * active contact is considered. Either way ONLY the existing eligibility check decides who is added: a contact that is unsubscribed, suppressed, bounced,
 * complained, inactive or without a valid marketing consent never becomes a recipient. The counts returned come from that service and the database.
 */
export async function adminPrepareCampaignAudience(adminId: unknown, campaignId: unknown, input: unknown, opts: Opts = {}): Promise<
  { ok: true; run: Extract<PrepareRecipientsResult, { ok: true }>; audience: AudienceSummary } | CampaignAdminFailure
> {
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  if (!isRecordId(campaignId)) return NOT_FOUND;
  const body = obj(input) ?? {};
  let contactIds: unknown;
  if (body.contactIds !== undefined && body.contactIds !== null) {
    if (!Array.isArray(body.contactIds) || body.contactIds.length < 1 || body.contactIds.length > MAX_PICKED_CONTACTS || !body.contactIds.every(isRecordId)) {
      return fail("invalid_input", `Choose between 1 and ${MAX_PICKED_CONTACTS} contacts, or use all contacts.`);
    }
    contactIds = body.contactIds;
  }
  const run = await prepareCampaignRecipients(campaignId, contactIds === undefined ? {} : { contactIds }, { db, now: opts.now });
  if (!run.ok) return fail(run.reason, run.message);
  await audit(db, actor, "email_campaign.prepare_audience", campaignId, { mode: contactIds === undefined ? "all" : "selected", added: run.added, skippedNow: run.skippedNow, recipientCount: run.recipientCount });
  return { ok: true, run, audience: await audienceSummary(db, campaignId) };
}

/** Contact picker for the "selected contacts" audience: the existing contact list, narrowed to the CANDIDATE filter; each row's verdict is the eligibility service's. */
export async function adminSearchAudienceContacts(adminId: unknown, q: unknown, opts: Opts = {}): Promise<
  { ok: true; contacts: { id: string; email: string; name: string | null; eligible: boolean }[] } | CampaignAdminFailure
> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) return FORBIDDEN;
  const list = await adminListEmailContacts(adminId, { q: typeof q === "string" ? q : "", filter: "eligible", page: 1 }, { db, now: opts.now });
  return { ok: true, contacts: list.rows.map((r) => ({ id: r.id, email: r.email, name: r.name, eligible: r.eligibility.eligible })) };
}

// ------------------------------------------------------------------------------------------------------------------------------------ review

const storeNameOf = async (db: Db): Promise<string> => {
  const s = (await db.storeSettings.findUnique({ where: { id: "singleton" } })) as { storeName?: unknown } | null;
  return typeof s?.storeName === "string" && s.storeName.trim() ? s.storeName.trim() : "Gift Pacific";
};
const escapeText = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * What the admin reviews before scheduling. The message is the campaign's OWN snapshot (the same subject / text / HTML the dispatcher will use), rendered
 * with sample customer data and a SAMPLE unsubscribe link (never a real token). The internal designer marker is removed again here and, if anything of it
 * were still present, the review is blocked. Every check is read from the database / environment, not from the browser.
 */
export async function adminGetCampaignReview(adminId: unknown, campaignId: unknown, opts: Opts = {}): Promise<{ ok: true; review: CampaignReview } | CampaignAdminFailure> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) return FORBIDDEN;
  const got = await getEmailCampaign(campaignId, { db });
  if (!got.ok) return NOT_FOUND;
  const c = got.campaign;
  const env = opts.env ?? process.env;
  const base = readUnsubscribeBaseUrl(env);
  const origin = base.ok ? base.origin : "https://shop.example.com";
  const storeName = await storeNameOf(db);
  const template = c.templateId ? await db.emailTemplate.findUnique({ where: { id: c.templateId }, select: { name: true, category: true } }) : null;

  const content = validateTemplateContent({ subject: c.subject, textBody: c.textBody, htmlBody: c.htmlBody });
  const checks: ReviewCheck[] = [];
  let subject = c.subject, html = "", text = "";
  if (content.ok) {
    const rendered = renderEmailTemplate({ ...content.value, htmlBody: stripDesignMarker(content.value.htmlBody) }, {
      customerName: "Sir/Medam", firstName: "Sir/Medam", email: "customer@example.com", storeName, unsubscribeUrl: `${origin}/unsubscribe/sample-preview-link`,
    });
    if (rendered.ok) {
      subject = rendered.subject; text = rendered.textBody;
      html = rendered.htmlBody ?? `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;padding:16px">${escapeText(rendered.textBody)}</pre>`;
    }
    checks.push({ id: "content", label: "Subject and message are valid", ok: rendered.ok, detail: rendered.ok ? null : rendered.errors[0]?.message ?? "The message is not valid." });
  } else checks.push({ id: "content", label: "Subject and message are valid", ok: false, detail: content.errors[0]?.message ?? "The message is not valid." });

  const linkProblems = unsubscribePlaceholderProblems({ subject: c.subject, textBody: c.textBody, htmlBody: stripDesignMarker(c.htmlBody) });
  checks.push({ id: "unsubscribe_link", label: "Unsubscribe link is in the message", ok: linkProblems.length === 0, detail: linkProblems[0]?.message ?? null });

  const marker = /gp-design/i.test(`${subject}\n${html}\n${text}`);
  checks.push({ id: "no_internal_marker", label: "No internal editor data in the customer-facing message", ok: !marker, detail: marker ? "The message still contains internal editor data and cannot be sent." : null });

  const unsub = readUnsubscribeConfig(env);
  checks.push({
    id: "unsubscribe_setup", label: "Unsubscribe links can be created", ok: unsub.ok,
    detail: unsub.ok ? null : unsub.reason === "base_url_invalid" ? "NEXT_PUBLIC_APP_URL is not a valid public https address." : `${UNSUBSCRIBE_SECRET_ENV} is not set to a strong dedicated secret.`,
  });

  const audience = await audienceSummary(db, c.id);
  checks.push({ id: "audience", label: "Audience is prepared", ok: audience.eligible > 0, detail: audience.eligible > 0 ? null : "No eligible recipient yet. Prepare the audience first." });
  checks.push({ id: "draft", label: "Campaign is still a draft", ok: c.status === "DRAFT", detail: c.status === "DRAFT" ? null : `This campaign is ${c.status.toLowerCase()}.` });

  return {
    ok: true,
    review: {
      campaign: { id: c.id, name: c.name, description: c.description, status: c.status, senderName: c.senderName, senderEmail: c.senderEmail, scheduledAt: iso(c.scheduledAt), templateName: template?.name ?? null, templateCategory: template ? String(template.category) : null },
      subject, html, text, audience, checks, ready: checks.every((k) => k.ok),
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------ transitions

type TransitionResult = { ok: true; id: string; status: CampaignStatus; scheduledAt: string | null } | CampaignAdminFailure;

/** DRAFT -> SCHEDULED through the existing transition (future time, prepared audience, valid content, unsubscribe prerequisites). Starts nothing: the scheduler does, when due. */
export async function adminScheduleCampaign(adminId: unknown, campaignId: unknown, scheduledAt: unknown, opts: Opts & { unsubscribeEnv?: Env } = {}): Promise<TransitionResult> {
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  const res = await transitionEmailCampaignStatus(campaignId, "SCHEDULED", { db, now: opts.now, scheduledAt, unsubscribeEnv: opts.unsubscribeEnv ?? opts.env });
  if (!res.ok) return fromCampaignFailure(res);
  await audit(db, actor, "email_campaign.schedule", res.campaign.id, { scheduledAt: iso(res.campaign.scheduledAt) });
  logServerInfo("email_campaign.scheduled", "campaign scheduled", { campaignId: res.campaign.id });
  return { ok: true, id: res.campaign.id, status: res.campaign.status, scheduledAt: iso(res.campaign.scheduledAt) };
}

export type SendNowDelivery = ManualRunReport & {
  /** Jobs of THIS campaign that are still waiting in the queue (PENDING) after this request. They are sent only by the next explicit click. */
  waiting: number;
  /** Recipients of this campaign not yet put in the queue (dispatch stopped at its time limit). Also resumed only by the next explicit click. */
  notYetQueued: number;
};
export type SendNowResult =
  | { ok: true; id: string; status: CampaignStatus | string; outcome: "queued" | "in_progress" | "partial"; enqueued: number; skipped: number; failed: number; message: string; delivery: SendNowDelivery | null }
  | CampaignAdminFailure;

/** Dispatch refusals that happen BEFORE anything was started or queued: the campaign goes back to DRAFT so it is not left "due" for an external dispatcher to fire unattended later. */
const NOTHING_STARTED = new Set(["invalid_snapshot", "unsubscribe_link_missing", "unsubscribe_link_unavailable", "no_recipients", "no_eligible_recipients", "invalid_status", "not_due"]);

type SendDeps = { unsubscribeEnv?: Env; chunkSize?: number; /** SMTP environment and transport for the queue run (default process.env and the real transport). Not the unsubscribe env. */ smtpEnv?: Env; factory?: Parameters<typeof runEmailQueueNow>[0]["factory"]; startedAt?: number };

/**
 * After dispatch queued recipients: ONE bounded run of the EXISTING queue worker, awaited here, limited to this campaign's own jobs. Never throws.
 * `waiting` is counted from the database afterwards, so the message reflects what really happened, not what was planned.
 */
async function runCampaignBatch(db: Db, campaignId: string, now: Date, deps: SendDeps, startedAt: number): Promise<SendNowDelivery> {
  // This campaign's jobs that the worker could claim right now (PENDING and due). Jobs waiting out a retry delay are not picked: they would only take a place in
  // the batch without being sendable. They are sent when the admin retries them from the send queue page.
  const jobIds: string[] = [];
  try {
    let after = "";
    while (jobIds.length < EMAIL_MANUAL_MAX_JOBS) {
      const rows = await db.emailCampaignRecipient.findMany({ where: { campaignId, status: "QUEUED", emailJobId: { not: null }, id: { gt: after } }, orderBy: { id: "asc" }, take: 200, select: { id: true, emailJobId: true } });
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const ids = rows.map((r) => r.emailJobId).filter((x): x is string => typeof x === "string");
      const due = await db.emailJob.findMany({
        where: { id: { in: ids }, status: "PENDING", nextAttemptAt: { lte: now }, attempts: { lt: EMAIL_JOB_MAX_ATTEMPTS } },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }], take: EMAIL_MANUAL_MAX_JOBS - jobIds.length, select: { id: true },
      });
      jobIds.push(...due.map((j) => j.id));
    }
  } catch { jobIds.length = 0; }
  const report = await runEmailQueueNow({ startedAt, jobIds, db, env: deps.smtpEnv, factory: deps.factory, now, maxJobs: EMAIL_MANUAL_MAX_JOBS });
  let waiting = 0; let notYetQueued = 0;
  try {
    const queued = await db.emailCampaignRecipient.findMany({ where: { campaignId, status: "QUEUED", emailJobId: { not: null } }, select: { emailJobId: true } });
    const ids = queued.map((r) => r.emailJobId).filter((x): x is string => typeof x === "string");
    waiting = ids.length ? await db.emailJob.count({ where: { id: { in: ids }, status: "PENDING" } }) : 0;
    notYetQueued = await db.emailCampaignRecipient.count({ where: { campaignId, status: "PENDING" } });
  } catch { /* the counts are informational */ }
  return { ...report, waiting, notYetQueued };
}

const deliveryMessage = (queued: string, d: SendNowDelivery): string => {
  const more = d.notYetQueued > 0 ? ` ${d.notYetQueued} recipient(s) are not queued yet (the time limit for one request was reached); use "Continue sending" to queue and send them.` : "";
  return `${queued} ${describeManualRun(d, d.waiting)}${more}`;
};

/**
 * SEND NOW: DRAFT -> (SCHEDULED, due immediately) -> the EXISTING dispatchEmailCampaign -> ONE bounded, awaited run of the EXISTING queue worker (this request,
 * no background work). All the protections are the existing ones and run on the server: the same prerequisites scheduling had (audience, content, unsubscribe
 * link and secret), the dispatcher's per-recipient consent / suppression re-check at dispatch time, the queue's dedupe keys (so a repeat can never double-queue
 * a recipient), and the worker's own eligibility re-check right before SMTP.
 * Only the admin's campaign id is read from the browser: no time, recipient list or eligibility verdict. A second click finds the campaign no longer a DRAFT and
 * is refused. If dispatch refuses before it started anything, the campaign is returned to DRAFT (nothing was queued). If it is interrupted or stops at its time
 * limit after queuing some recipients, the campaign stays SENDING and the admin continues it with "Continue sending" (idempotent): nothing is queued twice.
 * Whatever the send batch did not reach stays PENDING; nothing sends it later by itself.
 */
export async function adminSendCampaignNow(adminId: unknown, campaignId: unknown, opts: Opts & SendDeps = {}): Promise<SendNowResult> {
  const startedAt = opts.startedAt ?? Date.now();
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const env = opts.unsubscribeEnv ?? opts.env;

  const started = await startEmailCampaignNow(campaignId, { db, now, unsubscribeEnv: env });
  if (!started.ok) return fromCampaignFailure(started);
  const id = started.campaign.id;
  await audit(db, actor, "email_campaign.send_now", id, {});

  const result = await dispatchEmailCampaign(id, { db, now, chunkSize: opts.chunkSize ?? 50, deadlineMs: EMAIL_MANUAL_DISPATCH_DEADLINE_MS, unsubscribeEnv: env });
  if (result.ok) {
    const delivery = await runCampaignBatch(db, id, now, opts, startedAt);
    await audit(db, actor, "email_campaign.send_now_dispatched", id, { enqueued: result.enqueued, skipped: result.skipped, failed: result.failed, status: String(result.status), sent: delivery.sent, waiting: delivery.waiting });
    logServerInfo("email_campaign.send_now", "campaign handed to the e-mail queue", { campaignId: id, enqueued: result.enqueued, sent: delivery.sent, waiting: delivery.waiting });
    return {
      ok: true, id, status: result.status, outcome: "queued", enqueued: result.enqueued, skipped: result.skipped, failed: result.failed, delivery,
      message: deliveryMessage(`${result.enqueued} e-mail(s) were queued.`, delivery),
    };
  }
  const progress: DispatchProgress = result.progress ?? { enqueued: 0, reusedJobs: 0, skipped: 0, failed: 0 };
  if (result.reason === "already_dispatching" || result.reason === "already_dispatched") {
    // Another click got there first. Nothing to do and nothing was duplicated.
    return { ok: true, id, status: "SENDING", outcome: "in_progress", enqueued: 0, skipped: 0, failed: 0, delivery: null, message: "This campaign is already being sent. Use \"Continue sending\" on the campaign page to send the next batch." };
  }
  if (result.reason === "interrupted") {
    await audit(db, actor, "email_campaign.send_now_interrupted", id, { enqueued: progress.enqueued });
    const delivery = progress.enqueued > 0 ? await runCampaignBatch(db, id, now, opts, startedAt) : null;
    return {
      ok: true, id, status: "SENDING", outcome: "partial", enqueued: progress.enqueued, skipped: progress.skipped, failed: progress.failed, delivery,
      message: `Queuing was interrupted after ${progress.enqueued} e-mail(s) were queued.${delivery ? ` ${describeManualRun(delivery, delivery.waiting)}` : ""} Do not send the campaign again: use "Continue sending" on the campaign page, which resumes without queuing anyone twice.`,
    };
  }
  if (result.reason === "campaign_not_sending") return fail("campaign_not_sending", result.message);
  if (NOTHING_STARTED.has(result.reason)) {
    // Nothing was queued. Back to DRAFT (existing SCHEDULED -> DRAFT transition, conditional on SCHEDULED) so an external dispatcher, if one is ever configured, cannot send it later without the admin.
    try { await transitionEmailCampaignStatus(id, "DRAFT", { db, now }); } catch { /* still SCHEDULED and due: the protected dispatcher route handles it like any due campaign, if an operator calls it */ }
  }
  if (result.reason === "not_found") return NOT_FOUND;
  return fail(result.reason, result.message, result.errors);
}

export type ContinueSendingResult =
  | { ok: true; id: string; status: CampaignStatus | string; enqueued: number; skipped: number; failed: number; message: string; delivery: SendNowDelivery }
  | CampaignAdminFailure;

/**
 * CONTINUE SENDING (admin click): for a campaign that is already SENDING. It (1) resumes the EXISTING dispatch for recipients that are still PENDING, within
 * a short time limit, and (2) runs ONE more bounded, awaited batch of the EXISTING queue worker for this campaign's own jobs. Safe to click repeatedly and from two
 * tabs: dispatch is resumable and conditional (recipients are queued once), job claims are exclusive, and the worker re-checks consent, suppression and the
 * unsubscribe link before every send. Nothing runs unless an admin clicks.
 */
export async function adminContinueCampaignSending(adminId: unknown, campaignId: unknown, opts: Opts & SendDeps = {}): Promise<ContinueSendingResult> {
  const startedAt = opts.startedAt ?? Date.now();
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  if (!isRecordId(campaignId)) return NOT_FOUND;
  const now = opts.now ?? new Date();
  const env = opts.unsubscribeEnv ?? opts.env;
  const campaign = await db.emailCampaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true } });
  if (!campaign) return NOT_FOUND;
  if (campaign.status !== "SENDING") return fail("invalid_status", `Only a campaign that is sending can be continued (this one is ${String(campaign.status).toLowerCase()}).`);

  let progress: DispatchProgress = { enqueued: 0, reusedJobs: 0, skipped: 0, failed: 0 };
  const pending = await db.emailCampaignRecipient.count({ where: { campaignId, status: "PENDING" } });
  if (pending > 0) {
    const result = await dispatchEmailCampaign(campaignId, { db, now, chunkSize: opts.chunkSize ?? 50, deadlineMs: EMAIL_MANUAL_DISPATCH_DEADLINE_MS, unsubscribeEnv: env });
    if (result.ok) progress = { enqueued: result.enqueued, reusedJobs: result.reusedJobs, skipped: result.skipped, failed: result.failed };
    else if (result.reason === "campaign_not_sending") return fail("campaign_not_sending", result.message);
    else if (result.reason === "interrupted") progress = result.progress ?? progress;
    else if (result.reason !== "already_dispatched" && result.reason !== "already_dispatching") return fail(result.reason, result.message, result.errors);
  }
  const delivery = await runCampaignBatch(db, campaignId, now, opts, startedAt);
  await audit(db, actor, "email_campaign.continue_sending", campaignId, { enqueued: progress.enqueued, sent: delivery.sent, waiting: delivery.waiting });
  const current = await db.emailCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
  return {
    ok: true, id: campaignId, status: current?.status ?? "SENDING", enqueued: progress.enqueued, skipped: progress.skipped, failed: progress.failed, delivery,
    message: deliveryMessage(progress.enqueued > 0 ? `${progress.enqueued} more e-mail(s) were queued.` : "", delivery).trim(),
  };
}

/** SCHEDULED -> DRAFT through the existing transition (clears the time). */
export async function adminUnscheduleCampaign(adminId: unknown, campaignId: unknown, opts: Opts = {}): Promise<TransitionResult> {
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  const res = await transitionEmailCampaignStatus(campaignId, "DRAFT", { db, now: opts.now });
  if (!res.ok) return fromCampaignFailure(res);
  await audit(db, actor, "email_campaign.unschedule", res.campaign.id, {});
  return { ok: true, id: res.campaign.id, status: res.campaign.status, scheduledAt: iso(res.campaign.scheduledAt) };
}

/** -> CANCELLED through the existing transition. For a SENDING campaign the existing delivery gate then blocks every job that has not been sent yet. */
export async function adminCancelCampaign(adminId: unknown, campaignId: unknown, opts: Opts = {}): Promise<TransitionResult> {
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  const res = await transitionEmailCampaignStatus(campaignId, "CANCELLED", { db, now: opts.now });
  if (!res.ok) return fromCampaignFailure(res);
  await audit(db, actor, "email_campaign.cancel", res.campaign.id, {});
  return { ok: true, id: res.campaign.id, status: res.campaign.status, scheduledAt: iso(res.campaign.scheduledAt) };
}

// ------------------------------------------------------------------------------------------------------------------------------------ detail

async function deliveryOf(db: Db, campaignId: string): Promise<{ delivery: DeliveryBreakdown; skipReasons: ReasonCount[]; failureCodes: ReasonCount[] }> {
  const groups = (await db.emailCampaignRecipient.groupBy({ by: ["status", "skipReason", "errorCode"], where: { campaignId }, _count: { _all: true } })) as unknown as
    { status: string; skipReason: string | null; errorCode: string | null; _count: { _all: number } }[];
  const n = (s: string) => groups.filter((g) => g.status === s).reduce((a, g) => a + g._count._all, 0);
  const total = groups.reduce((a, g) => a + g._count._all, 0);
  const sent = n("SENT"), failed = n("FAILED"), skipped = n("SKIPPED");
  const processed = sent + failed + skipped;
  return {
    delivery: { total, pending: n("PENDING"), queued: n("QUEUED"), sent, failed, skipped, processed, percent: total ? Math.round((processed / total) * 100) : 0 },
    skipReasons: reasonCounts(groups.filter((g) => g.status === "SKIPPED").map((g) => ({ key: g.skipReason, n: g._count._all }))),
    failureCodes: reasonCounts(groups.filter((g) => g.status === "FAILED").map((g) => ({ key: g.errorCode, n: g._count._all }))),
  };
}

/** Campaign page data: information, template, delivery progress and ONE page of recipients (25 per page). Only fixed codes are shown, never raw server replies. */
export async function adminGetCampaignDetail(adminId: unknown, id: unknown, input: { page?: unknown; status?: unknown } = {}, opts: Opts = {}): Promise<{ ok: true; campaign: CampaignDetail } | CampaignAdminFailure> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) return FORBIDDEN;
  const got = await getEmailCampaign(id, { db });
  if (!got.ok) return NOT_FOUND;
  const c = got.campaign;
  const statusFilter: RecipientStatus | null = isRecipientStatus(input.status) ? input.status : null;
  const pageNum = Number(input.page);
  const page = Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= 100_000 ? pageNum : 1;
  const where = { campaignId: c.id, ...(statusFilter ? { status: statusFilter } : {}) };

  const [template, delivery, total, rows] = await Promise.all([
    c.templateId ? db.emailTemplate.findUnique({ where: { id: c.templateId }, select: { id: true, name: true, category: true, isActive: true } }) : Promise.resolve(null),
    deliveryOf(db, c.id),
    db.emailCampaignRecipient.count({ where }),
    db.emailCampaignRecipient.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (page - 1) * RECIPIENTS_PAGE_SIZE, take: RECIPIENTS_PAGE_SIZE }),
  ]);
  const contacts = rows.length ? await db.emailContact.findMany({ where: { id: { in: rows.map((r) => r.contactId) } }, select: { id: true, email: true, name: true } }) : [];
  const contactBy = new Map(contacts.map((x) => [x.id, x]));
  const recipientRows: RecipientRow[] = rows.map((r) => ({
    id: r.id, contactId: r.contactId, email: contactBy.get(r.contactId)?.email ?? null, name: contactBy.get(r.contactId)?.name ?? null, status: r.status as RecipientStatus,
    reason: safeErrorCode(r.status === "SKIPPED" ? r.skipReason : r.errorCode) ?? null, queuedAt: iso(r.queuedAt), sentAt: iso(r.sentAt), updatedAt: isoOr(r.updatedAt),
  }));

  return {
    ok: true,
    campaign: {
      id: c.id, name: c.name, description: c.description, status: c.status, subject: c.subject, senderName: c.senderName, senderEmail: c.senderEmail,
      scheduledAt: iso(c.scheduledAt), startedAt: iso(c.startedAt), completedAt: iso(c.completedAt), cancelledAt: iso(c.cancelledAt), createdAt: isoOr(c.createdAt), updatedAt: isoOr(c.updatedAt),
      failureCode: safeErrorCode(c.failureReason), hasUnsubscribeLink: unsubscribePlaceholderProblems({ subject: c.subject, textBody: c.textBody, htmlBody: c.htmlBody }).length === 0,
      template: template ? { id: template.id, name: template.name, category: String(template.category), isActive: template.isActive } : null,
      ...delivery, actions: campaignActionsFor(c.status),
      recipients: { rows: recipientRows, total, page, pageCount: Math.max(1, Math.ceil(total / RECIPIENTS_PAGE_SIZE)), pageSize: RECIPIENTS_PAGE_SIZE, status: statusFilter },
    },
  };
}
