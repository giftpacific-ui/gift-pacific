import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { siteConfig } from "@/config/site";
import type { MarketingSkipReason } from "@/lib/email/marketing";
import { isRecordId, validateTemplateContent, type FieldError } from "@/lib/email/template-rules";
import type { CampaignStatus } from "@/lib/email/campaign-rules";
import { assessDispatchState, buildCampaignMessage, CAMPAIGN_SEND_BLOCK, unsubscribePlaceholderProblems, type CampaignMessage, type DeliveryCounts } from "@/lib/email/campaign-dispatch-rules";
import { readUnsubscribeConfig, UNSUBSCRIBE_SECRET_ENV } from "@/lib/email/unsubscribe";
import { ensureContactUnsubscribeLink } from "@/server/services/email-unsubscribe.service";
import { enqueueEmails } from "@/server/services/email-queue.service";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { reconcileCampaign } from "@/server/services/email-campaign-delivery.service";
import { logServerInfo, logServerWarning } from "@/lib/logger";

type Db = typeof prisma;
type EligibilityDb = NonNullable<Parameters<typeof getMarketingEligibility>[1]>["db"];

/**
 * Campaign dispatch (Prompt 10): turns the prepared audience of a SCHEDULED (due) campaign into EmailJobs on the EXISTING queue. It sends nothing:
 * the queue worker (email-queue.service, POST /api/email/queue) delivers, one job at a time, within its retry and rate limits, and re-checks
 * eligibility again right before SMTP (email-campaign-delivery.service).
 *
 * For every PENDING recipient, in chunks and ONE transaction per chunk:
 *   1. re-run the P08 eligibility check NOW (a stored result is never trusted; a recipient who unsubscribed since the audience was prepared
 *      becomes SKIPPED with the fixed reason; anything unverifiable is excluded, fail closed);
 *   2. build the personalised message from the campaign's own snapshot and queue it with enqueueEmails (kind "campaign", dedupe parts
 *      [campaignId, recipientId], so the same recipient can never get two jobs);
 *   3. link it: recipient.emailJobId = job id, status QUEUED (never SENT: that is the worker's word).
 * A chunk is atomic, so a job never exists without its link, and a failure rolls back that chunk only. Dispatch is RESUMABLE: calling it again on a
 * SENDING campaign continues with the recipients still PENDING; nothing already queued is touched or duplicated.
 *
 * Concurrency: starting is one conditional update (SCHEDULED -> SENDING); a second starter gets "already_dispatching". Every chunk first locks the
 * campaign row with a conditional update (status must still be SENDING), recipient writes are conditional on status = PENDING, and job creation is
 * deduplicated by the queue's unique key, so two overlapping resumes cannot double-queue. (The tests for this run on an in-memory database that
 * serialises transactions; the row-lock and unique-key behaviour themselves are PostgreSQL's and are covered by the integration tests.)
 *
 * The campaign is COMPLETED only by reconcileCampaign, when every recipient is settled: never because jobs were queued.
 *
 * Prompt 11 (unsubscribe): NO marketing message is queued without its recipient's working unsubscribe URL.
 *   - Before anything starts (and before the SCHEDULED -> SENDING move, also when resuming): the campaign's text body, and its HTML body when there is
 *     one, must use {{unsubscribeUrl}} ("unsubscribe_link_missing"), and the dedicated secret and public https base URL must be usable
 *     ("unsubscribe_link_unavailable"). Either failure writes and queues nothing.
 *   - Per recipient, inside the chunk transaction and only after the eligibility re-check: the contact's STABLE link is created (the hash is stored if
 *     it was not yet), the message is rendered with it, and the builder refuses a message that does not contain it. A recipient whose link cannot be
 *     created becomes FAILED("unsubscribe_unavailable"): its e-mail is never queued, the others continue, and nothing is sent without a link.
 *   - The link is the same for every campaign the contact receives; sending another campaign never changes it.
 */

const DEFAULT_CHUNK = 100;
const MAX_CHUNK = 500;
const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

export type DispatchFailure = {
  ok: false;
  reason:
    | "not_found" | "invalid_status" | "not_due" | "invalid_snapshot" | "unsubscribe_link_missing" | "unsubscribe_link_unavailable" | "no_recipients" | "no_eligible_recipients"
    | "already_dispatched" | "already_dispatching" | "campaign_not_sending" | "interrupted";
  message: string;
  errors?: FieldError[];
  /** For "interrupted" / "campaign_not_sending": what was queued before it stopped (safe to resume). */
  progress?: DispatchProgress;
};
export type DispatchProgress = { enqueued: number; reusedJobs: number; skipped: number; failed: number };
export type DispatchSuccess = DispatchProgress & {
  ok: true;
  campaignId: string;
  resumed: boolean;
  /** True when the caller's `deadlineMs` stopped dispatch between chunks. Whoever is still PENDING stays PENDING (counts.pending) and is queued by the next dispatch call. */
  timedOut?: boolean;
  status: CampaignStatus | string;
  /** Recipient counts after this call. `queued` are waiting in the queue, NOT delivered. */
  counts: DeliveryCounts;
};
export type DispatchResult = DispatchSuccess | DispatchFailure;

class NotSending extends Error {}
const elig = (tx: Prisma.TransactionClient) => tx as unknown as EligibilityDb;
const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");
const fail = (reason: DispatchFailure["reason"], message: string, extra: Partial<DispatchFailure> = {}): DispatchFailure => ({ ok: false, reason, message, ...extra });

async function judge(tx: Prisma.TransactionClient, email: string, now: Date): Promise<{ ok: true } | { ok: false; reason: MarketingSkipReason }> {
  try {
    const v = await getMarketingEligibility(email, { db: elig(tx), now });
    return v.eligible && v.consentId ? { ok: true } : { ok: false, reason: v.eligible ? "unverifiable" : v.reason };
  } catch {
    return { ok: false, reason: "unverifiable" };
  }
}

/** Read-only: is at least one PENDING recipient eligible right now? Stops at the first one found. */
async function anyEligible(db: Db, campaignId: string, now: Date, chunk: number): Promise<boolean> {
  let after = "";
  for (;;) {
    const rows = await db.emailCampaignRecipient.findMany({ where: { campaignId, status: "PENDING", id: { gt: after } }, orderBy: { id: "asc" }, take: chunk, select: { id: true, contactId: true } });
    if (!rows.length) return false;
    after = rows[rows.length - 1].id;
    const contacts = await db.emailContact.findMany({ where: { id: { in: rows.map((r) => r.contactId) } }, select: { id: true, email: true } });
    for (const c of contacts) {
      const v = await getMarketingEligibility(c.email, { db: elig(db as unknown as Prisma.TransactionClient), now });
      if (v.eligible && v.consentId) return true;
    }
  }
}

/** Dispatches (or resumes) a campaign. Returns a structured result; unexpected failures are reported as "interrupted" and are safe to retry. */
export async function dispatchEmailCampaign(campaignId: unknown, opts: { db?: Db; now?: Date; chunkSize?: number; /** Admin-triggered calls: stop starting new chunks after this many ms (the rest stays PENDING and a later call resumes it). Omitted = run to the end, as the protected scheduler route does. */ deadlineMs?: number; /** Environment the unsubscribe secret and base URL are read from (default process.env). Deliberately NOT called `env`: the SMTP env is a different thing. */ unsubscribeEnv?: Record<string, string | undefined> } = {}): Promise<DispatchResult> {
  if (!isRecordId(campaignId)) return fail("not_found", "Campaign not found.");
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.unsubscribeEnv ?? process.env;
  const chunk = Number.isInteger(opts.chunkSize) && (opts.chunkSize as number) >= 1 ? Math.min(opts.chunkSize as number, MAX_CHUNK) : DEFAULT_CHUNK;

  const campaign = await db.emailCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return fail("not_found", "Campaign not found.");

  const state = assessDispatchState(campaign.status, campaign.scheduledAt, now);
  if (!state.ok) return fail(state.reason, state.message);

  // The campaign's own snapshot must still be a valid message.
  const content = validateTemplateContent(campaign);
  if (!content.ok) return fail("invalid_snapshot", "The campaign content is not valid.", { errors: content.errors });
  const snapshot = { subject: content.value.subject, textBody: content.value.textBody, htmlBody: content.value.htmlBody };

  // Prompt 11: every campaign e-mail needs its recipient's unsubscribe link. Both checks run BEFORE the campaign is started or anything is queued.
  const linkProblems = unsubscribePlaceholderProblems(snapshot);
  if (linkProblems.length) return fail("unsubscribe_link_missing", "A campaign must contain {{unsubscribeUrl}} (in the text body and, if present, the HTML body) and not in the subject.", { errors: linkProblems });
  const unsubscribe = readUnsubscribeConfig(env);
  if (!unsubscribe.ok) {
    const what = unsubscribe.reason === "base_url_invalid" ? "NEXT_PUBLIC_APP_URL is not a valid public https address" : `${UNSUBSCRIBE_SECRET_ENV} is not set to a strong dedicated secret`;
    return fail("unsubscribe_link_unavailable", `Unsubscribe links cannot be created: ${what}. Nothing was queued.`);
  }

  const total = await db.emailCampaignRecipient.count({ where: { campaignId } });
  const pending = await db.emailCampaignRecipient.count({ where: { campaignId, status: "PENDING" } });
  if (state.resumed) {
    if (pending === 0) return fail("already_dispatched", "Every recipient of this campaign has already been processed.");
  } else {
    if (campaign.recipientCount < 1 || total < 1 || pending < 1) return fail("no_recipients", "Prepare the campaign audience before dispatching it.");
    if (!(await anyEligible(db, campaignId, now, chunk))) return fail("no_eligible_recipients", "None of the prepared recipients is eligible to receive marketing e-mail now.");
    // The ONE place a campaign starts sending: conditional, so only one of several concurrent requests wins.
    const started = await db.emailCampaign.updateMany({ where: { id: campaignId, status: "SCHEDULED" }, data: { status: "SENDING", startedAt: now } });
    if (started.count !== 1) return fail("already_dispatching", "This campaign is already being dispatched.");
  }

  const progress: DispatchProgress = { enqueued: 0, reusedJobs: 0, skipped: 0, failed: 0 };
  const startedAt = Date.now();
  let timedOut = false;
  try {
    let after = "";
    for (;;) {
      const stats: DispatchProgress = { enqueued: 0, reusedJobs: 0, skipped: 0, failed: 0 }; // per chunk: merged only once the chunk has committed
      const last = await db.$transaction(async (tx: Prisma.TransactionClient) => {
        stats.enqueued = stats.reusedJobs = stats.skipped = stats.failed = 0; // (a transaction is not retried here, but never carry numbers over)
        // Locks the campaign row for this chunk and proves it is still SENDING (a cancel in between stops the dispatch).
        const guard = await tx.emailCampaign.updateMany({ where: { id: campaignId, status: "SENDING" }, data: { updatedAt: now } });
        if (guard.count === 0) throw new NotSending();

        const rows = await tx.emailCampaignRecipient.findMany({ where: { campaignId, status: "PENDING", id: { gt: after } }, orderBy: { id: "asc" }, take: chunk, select: { id: true, contactId: true } });
        if (!rows.length) return null;
        const contacts = await tx.emailContact.findMany({ where: { id: { in: rows.map((r) => r.contactId) } }, select: { id: true, email: true, name: true, unsubscribeTokenHash: true } });
        const contactById = new Map(contacts.map((c) => [c.id, c]));

        const toQueue: { recipientId: string; message: Extract<CampaignMessage, { ok: true }> }[] = [];
        const skip = async (id: string, reason: MarketingSkipReason) => {
          const r = await tx.emailCampaignRecipient.updateMany({ where: { id, status: "PENDING" }, data: { status: "SKIPPED", skipReason: reason } });
          stats.skipped += r.count;
        };
        for (const row of rows) {
          const contact = contactById.get(row.contactId);
          if (!contact) { await skip(row.id, "no_contact"); continue; }
          const verdict = await judge(tx, contact.email, now); // re-checked NOW, never taken from the stored audience
          if (!verdict.ok) { await skip(row.id, verdict.reason); continue; }
          // Prompt 11: the recipient's STABLE unsubscribe link (the same one in every campaign). No link = no e-mail: this recipient is FAILED, never queued.
          const link = await ensureContactUnsubscribeLink(tx, contact, unsubscribe, env);
          if (!link.ok) {
            const r = await tx.emailCampaignRecipient.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "FAILED", errorCode: CAMPAIGN_SEND_BLOCK.unsubscribeUnavailable } });
            stats.failed += r.count;
            continue;
          }
          const message = buildCampaignMessage(campaignId, row.id, contact, snapshot, siteConfig.name, link.url);
          if (!message.ok) {
            const r = await tx.emailCampaignRecipient.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "FAILED", errorCode: CAMPAIGN_SEND_BLOCK.invalidMessage } });
            stats.failed += r.count;
            continue;
          }
          toQueue.push({ recipientId: row.id, message });
        }

        if (toQueue.length) {
          const queued = await enqueueEmails(toQueue.map((q) => q.message.input), { db: tx as unknown as Db, now, priority: "bulk" });
          if (!queued.ok || queued.invalid.length > 0) throw new Error("enqueue_failed"); // roll the whole chunk back; resuming redoes it
          stats.reusedJobs += queued.duplicates;
          const jobs = await tx.emailJob.findMany({ where: { dedupeKey: { in: toQueue.map((q) => q.message.dedupeKey) } }, select: { id: true, dedupeKey: true } });
          const jobByKey = new Map(jobs.map((j) => [j.dedupeKey, j.id]));
          for (const q of toQueue) {
            const jobId = jobByKey.get(q.message.dedupeKey);
            if (!jobId) throw new Error("job_missing");
            const link = await tx.emailCampaignRecipient.updateMany({ where: { id: q.recipientId, status: "PENDING" }, data: { status: "QUEUED", emailJobId: jobId, queuedAt: now } });
            stats.enqueued += link.count;
          }
        }
        return rows[rows.length - 1].id;
      }, TX_OPTIONS);
      progress.enqueued += stats.enqueued; progress.reusedJobs += stats.reusedJobs; progress.skipped += stats.skipped; progress.failed += stats.failed;
      if (last === null) break;
      after = last;
      if (opts.deadlineMs !== undefined && Date.now() - startedAt >= opts.deadlineMs) { timedOut = true; break; } // between chunks only: a chunk is atomic
    }
  } catch (error) {
    if (error instanceof NotSending) return fail("campaign_not_sending", "The campaign is no longer sending; nothing more was queued.", { progress });
    logServerWarning("email_campaign.dispatch_interrupted", `Campaign dispatch stopped (${errName(error)})`, { campaignId, enqueued: progress.enqueued });
    return fail("interrupted", "Dispatch stopped before every recipient was processed. It is safe to run it again: it resumes where it stopped.", { progress });
  }

  const settled = await reconcileCampaign(campaignId, { db, now });
  logServerInfo("email_campaign.dispatched", "Campaign dispatched to the e-mail queue", { campaignId, enqueued: progress.enqueued, skipped: progress.skipped, failed: progress.failed, resumed: state.resumed });
  const counts = settled?.counts ?? { total: 0, pending: 0, queued: 0, sent: 0, failed: 0, skipped: 0 };
  return { ok: true, campaignId, resumed: state.resumed, status: settled?.status ?? "SENDING", counts, timedOut: timedOut && counts.pending > 0, ...progress };
}
