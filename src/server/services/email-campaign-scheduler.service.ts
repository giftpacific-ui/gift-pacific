import "server-only";
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";
import { canSystemTransitionCampaign } from "@/lib/email/campaign-rules";
import { CAMPAIGN_SEND_BLOCK } from "@/lib/email/campaign-dispatch-rules";
import type { MarketingSkipReason } from "@/lib/email/marketing";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { dispatchEmailCampaign, type DispatchFailure } from "@/server/services/email-campaign-dispatch.service";
import { reconcileCampaign } from "@/server/services/email-campaign-delivery.service";
import { logServerInfo, logServerWarning } from "@/lib/logger";

type Db = typeof prisma;
type EligibilityDb = NonNullable<Parameters<typeof getMarketingEligibility>[1]>["db"];

/**
 * Automated dispatch of due campaigns (Prompt 12). It adds NO second queue, worker or scheduler: an external scheduler calls
 * POST /api/email/campaigns/dispatch (same Bearer CRON_SECRET contract as /api/email/queue), which calls `dispatchDueCampaigns`, which calls the
 * EXISTING `dispatchEmailCampaign` (Prompt 10) for each campaign it wins. That function still does everything that matters: it re-validates the
 * campaign's snapshot and the P11 unsubscribe prerequisites, re-checks every recipient's eligibility, queues the jobs on the EXISTING EmailJob queue
 * with their dedupe keys, and is resumable. This module only decides WHICH campaigns to hand to it, and makes sure that exactly one caller does.
 *
 * What is picked, per invocation, bounded by `limit` (ids only are loaded, never whole campaigns):
 *   1. status SCHEDULED and scheduledAt <= now, oldest first. DRAFT, CANCELLED, COMPLETED, FAILED and future campaigns are never read as candidates.
 *   2. with whatever capacity is left: status SENDING campaigns that still have PENDING recipients AND have not been touched for RESUME_STALE_MS. A
 *      running dispatch touches the campaign row at the start of every chunk, so a recently touched campaign is being worked on and is left alone; a
 *      stale one was interrupted (crash, timeout) and is resumed through the normal P10 resume path.
 *
 * How two callers can never dispatch the same campaign (no in-memory lock; the database decides):
 *   - CLAIM: before dispatching, a candidate is claimed with ONE conditional update `WHERE id AND status AND updatedAt = <the value just read>` that
 *     writes a strictly larger updatedAt. Exactly one concurrent caller sees count = 1; every other one read the old value, matches nothing, and
 *     moves on ("skipped"). A repeated cron request finds nothing due (the campaign is SENDING and recently touched), so it does nothing.
 *   - START: dispatchEmailCampaign itself moves SCHEDULED -> SENDING with a conditional update, and every chunk re-proves the campaign is SENDING.
 *   - NO DUPLICATE MAIL EVEN IF BOTH GUARDS FAILED: recipient writes are conditional on status = PENDING and each recipient's job has the unique
 *     dedupe key [campaignId, recipientId], so the same recipient can never get two jobs (Prompt 10).
 *
 * A campaign that cannot be sent never enqueues anything and never blocks the others: each campaign runs in its own try/catch. Failures are classified:
 *   - TRANSIENT (can heal, always left resumable): the unsubscribe secret/base URL is missing or invalid ("unsubscribe_link_unavailable"), and an
 *     interrupted run ("interrupted"; dispatch reports it without a cause, so a database blip cannot be told apart from anything else and is never
 *     treated as final). A campaign in this state is retried at most once per CAMPAIGN_RESUME_STALE_MS and never duplicates anything.
 *   - PERMANENT AT START (a SCHEDULED campaign; its snapshot or audience is unusable and content is frozen once it leaves DRAFT; NOTHING was queued, so
 *     no job exists): the campaign is closed SCHEDULED -> FAILED with the fixed code, and its remaining PENDING recipients are settled IN THE SAME
 *     TRANSACTION, so a terminal FAILED campaign never keeps a PENDING recipient. The transaction first proves the campaign is still SCHEDULED (a
 *     concurrent cancel changes nothing, recipients included), settles only status PENDING rows, recomputes the campaign counts from the final rows and
 *     closes the campaign conditionally on SCHEDULED; any failed step rolls everything back and leaves the campaign SCHEDULED and retryable. That move
 *     is listed in SYSTEM_TRANSITIONS (campaign-rules) and is not a public transition. EmailJobs and dedupe keys are never created or touched.
 *       - "invalid_snapshot" / "unsubscribe_link_missing" / "no_recipients": PENDING recipients become FAILED with a fixed code.
 *       - "no_eligible_recipients": dispatch's answer is only "I did not find an eligible one", which a failed eligibility check cannot be told apart
 *         from. So the PENDING recipients are re-judged by the existing marketing eligibility service INSIDE the transaction. Only when every one of
 *         them is VERIFIABLY ineligible are they settled SKIPPED with their own actual reason and the campaign closed. If any answer is "unverifiable",
 *         throws, or a recipient is eligible now, nothing is written: the campaign stays SCHEDULED and is retried by the next run (transient).
 *   - PERMANENT ON RESUME (a SENDING campaign whose snapshot became unusable: "invalid_snapshot", "unsubscribe_link_missing"): the campaign is NOT marked
 *     FAILED, because the delivery gate blocks every queued job of a campaign that is not SENDING, which would abandon recipients that are already queued.
 *     Instead only the recipients still PENDING (they can never be sent) are settled as FAILED with the matching recipient code, inside one transaction
 *     that first proves the campaign is still SENDING. Queued and settled recipients, their jobs and the dedupe keys are untouched; the campaign stays
 *     SENDING until its queued jobs settle and the existing reconcile completes it (counts include the failed recipients). With nothing PENDING left it
 *     is no longer a resume candidate, so there is no retry loop.
 *
 * Logs carry campaign ids, fixed codes and counts only: no address, subject, body, link or secret.
 */

export const DUE_CAMPAIGN_DEFAULT_LIMIT = 3;
export const DUE_CAMPAIGN_MAX_LIMIT = 10;
/** A SENDING campaign untouched for this long is treated as interrupted and may be resumed. A running dispatch touches it at every chunk (<= 30 s each). */
export const CAMPAIGN_RESUME_STALE_MS = 5 * 60_000;
/** Stop starting new campaigns after this long (the route's maxDuration is 60 s); the rest waits for the next invocation. */
export const DUE_CAMPAIGN_RUN_DEADLINE_MS = 40_000;

/**
 * Dispatch refusals that cannot change once the campaign is SCHEDULED (content is frozen, the audience is fixed): the campaign is closed as FAILED.
 * The value is the fixed code that the campaign's still-PENDING recipients are settled with ("re-judge" = they are first re-evaluated for eligibility).
 */
const PERMANENT_AT_START: ReadonlyMap<DispatchFailure["reason"], string | "re-judge"> = new Map([
  ["invalid_snapshot", CAMPAIGN_SEND_BLOCK.invalidMessage],
  ["unsubscribe_link_missing", CAMPAIGN_SEND_BLOCK.unsubscribeMissing],
  ["no_recipients", "campaign_closed"],
  ["no_eligible_recipients", "re-judge"],
]);
/** Refusals of a RESUME that cannot change either (content is frozen once the campaign has left DRAFT), and the recipient code each one is settled with. */
const PERMANENT_ON_RESUME: ReadonlyMap<DispatchFailure["reason"], string> = new Map([
  ["invalid_snapshot", CAMPAIGN_SEND_BLOCK.invalidMessage],
  ["unsubscribe_link_missing", CAMPAIGN_SEND_BLOCK.unsubscribeMissing],
]);
/** Refusals that only mean "someone else got there first, or there is nothing left to do": not failures. */
const NOT_A_FAILURE: ReadonlySet<DispatchFailure["reason"]> = new Set(["already_dispatching", "already_dispatched", "not_due", "invalid_status", "not_found", "campaign_not_sending"]);

export type DueCampaignSummary = {
  /** Campaigns looked at this run: dispatched + skipped + failed. */
  processed: number;
  /** Campaigns handed to the dispatcher that queued (or resumed queuing) their recipients. A subset were resumes of an earlier, interrupted run. */
  dispatched: number;
  resumed: number;
  /** Campaigns left alone: another caller claimed them first, or there was nothing to do. */
  skipped: number;
  /** Campaigns the dispatcher refused or that crashed. Nothing was queued for a refused campaign. */
  failed: number;
  /** More work is waiting than this run was allowed to take (batch limit or time limit). */
  hasMore: boolean;
};

type Candidate = { id: string; updatedAt: Date; from: "SCHEDULED" | "SENDING" };

const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");
const validDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

/**
 * Exactly one concurrent caller wins. The new updatedAt is strictly greater than the one read, so a caller that read the old value can never match
 * again, even if two claims happen within the same millisecond. A row without a real updatedAt is never claimed (never an unfiltered write).
 */
async function claim(db: Db, c: Candidate, now: Date): Promise<boolean> {
  if (!validDate(c.updatedAt)) return false;
  const next = new Date(Math.max(now.getTime(), c.updatedAt.getTime() + 1));
  const res = await db.emailCampaign.updateMany({ where: { id: c.id, status: c.from, updatedAt: c.updatedAt }, data: { updatedAt: next } });
  return res.count === 1;
}

/**
 * A SENDING campaign that can never queue its remaining recipients: settle exactly those (status PENDING) as FAILED with `code`, and nothing else. The
 * transaction first locks the campaign row and proves it is still SENDING (a cancel in between changes nothing), the same guard every dispatch chunk
 * uses. QUEUED / SENT / SKIPPED / FAILED recipients, their jobs and the dedupe keys are never touched. The campaign status is left alone: the existing
 * reconcile completes it once its queued jobs have settled (and right now when none are left).
 */
async function settlePendingRecipients(db: Db, campaignId: string, code: string, now: Date): Promise<void> {
  const settled = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const guard = await tx.emailCampaign.updateMany({ where: { id: campaignId, status: "SENDING" }, data: { updatedAt: now } });
    if (guard.count === 0) return 0;
    return (await tx.emailCampaignRecipient.updateMany({ where: { campaignId, status: "PENDING" }, data: { status: "FAILED", errorCode: code } })).count;
  });
  if (settled > 0) await reconcileCampaign(campaignId, { db, now });
  logServerWarning("email_campaign_scheduler.settled_pending", "Recipients that can never be queued were settled as failed", { campaignId, code, recipients: settled });
}

/** Why a close did not happen: the campaign was changed by someone else, or the answer is not final yet. Thrown inside the transaction to roll it back. */
class CloseAborted extends Error {
  constructor(readonly outcome: "changed" | "retry") { super(outcome); }
}
export type CloseOutcome = "closed" | "changed" | "retry";
const SETTLE_PAGE = 200;
const CLOSE_TX = { timeout: 30_000, maxWait: 10_000 };
const asEligibilityDb = (tx: Prisma.TransactionClient) => tx as unknown as EligibilityDb;

/**
 * Re-judges every PENDING recipient with the existing eligibility service (read-only, same rule dispatch uses: eligible only with a consent id).
 * Returns the recipients grouped by their ACTUAL skip reason, or throws CloseAborted("retry") the moment anything is not a verifiable "ineligible":
 * a recipient that is eligible now, an "unverifiable" verdict, a failing query, or no PENDING recipient at all. Nothing is written here.
 */
async function judgeAllPending(tx: Prisma.TransactionClient, campaignId: string, now: Date): Promise<Map<MarketingSkipReason, string[]>> {
  const byReason = new Map<MarketingSkipReason, string[]>();
  let after = "";
  let seen = 0;
  for (;;) {
    const rows = await tx.emailCampaignRecipient.findMany({ where: { campaignId, status: "PENDING", id: { gt: after } }, orderBy: { id: "asc" }, take: SETTLE_PAGE, select: { id: true, contactId: true } });
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    const contacts = await tx.emailContact.findMany({ where: { id: { in: rows.map((r) => r.contactId) } }, select: { id: true, email: true } });
    const emailById = new Map(contacts.map((c) => [c.id, c.email]));
    for (const row of rows) {
      seen += 1;
      const email = emailById.get(row.contactId);
      let reason: MarketingSkipReason;
      if (email === undefined) reason = "no_contact"; // the contact row is verifiably gone: the same reason dispatch itself records
      else {
        let verdict: Awaited<ReturnType<typeof getMarketingEligibility>>;
        try { verdict = await getMarketingEligibility(email, { db: asEligibilityDb(tx), now }); } catch { throw new CloseAborted("retry"); }
        if (verdict.eligible) throw new CloseAborted("retry"); // somebody can receive it now: not a dead audience
        if (verdict.reason === "unverifiable") throw new CloseAborted("retry"); // a failed check proves nothing
        reason = verdict.reason;
      }
      byReason.set(reason, [...(byReason.get(reason) ?? []), row.id]);
    }
  }
  if (seen === 0) throw new CloseAborted("retry"); // nothing to judge any more: the situation changed, let the next run decide again
  return byReason;
}

/**
 * Closes a SCHEDULED campaign as FAILED (the system-only move) and settles its PENDING recipients, in ONE transaction:
 *   1. lock the campaign row and prove it is still SCHEDULED (otherwise nothing at all is written);
 *   2. settle ONLY recipients with status PENDING: FAILED with `settle.code`, or (re-judge) SKIPPED with their own verified eligibility reason;
 *   3. prove no PENDING recipient is left, recompute the counts from the final rows, and close the campaign conditionally on SCHEDULED.
 * Any step that does not hold throws and rolls everything back. SENT / SKIPPED / FAILED / QUEUED recipients, EmailJobs and dedupe keys are never written.
 * Never throws: a database error is reported as "retry" (the campaign is still SCHEDULED, so the next run tries again).
 */
export async function closeScheduledCampaign(db: Db, campaignId: string, failureReason: string, settle: { code: string } | "re-judge", now: Date): Promise<CloseOutcome> {
  if (!canSystemTransitionCampaign("SCHEDULED", "FAILED")) return "retry";
  try {
    const result = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const lock = await tx.emailCampaign.updateMany({ where: { id: campaignId, status: "SCHEDULED" }, data: { updatedAt: now } });
      if (lock.count === 0) throw new CloseAborted("changed");

      if (settle === "re-judge") {
        const byReason = await judgeAllPending(tx, campaignId, now);
        for (const [reason, ids] of byReason) {
          for (let i = 0; i < ids.length; i += SETTLE_PAGE) {
            const part = ids.slice(i, i + SETTLE_PAGE);
            const res = await tx.emailCampaignRecipient.updateMany({ where: { campaignId, id: { in: part }, status: "PENDING" }, data: { status: "SKIPPED", skipReason: reason } });
            if (res.count !== part.length) throw new CloseAborted("retry"); // a recipient changed under us: do not close on a stale judgement
          }
        }
      } else {
        await tx.emailCampaignRecipient.updateMany({ where: { campaignId, status: "PENDING" }, data: { status: "FAILED", errorCode: settle.code } });
      }

      const count = (status?: "PENDING" | "SENT" | "FAILED" | "SKIPPED") => tx.emailCampaignRecipient.count({ where: { campaignId, ...(status ? { status } : {}) } });
      const [total, pending, sent, failed, skipped] = await Promise.all([count(), count("PENDING"), count("SENT"), count("FAILED"), count("SKIPPED")]);
      if (pending > 0) throw new CloseAborted("retry"); // a terminal campaign must never keep a PENDING recipient
      const closed = await tx.emailCampaign.updateMany({
        where: { id: campaignId, status: "SCHEDULED" },
        data: { status: "FAILED", failureReason, recipientCount: total, sentCount: sent, failedCount: failed, skippedCount: skipped },
      });
      if (closed.count !== 1) throw new CloseAborted("changed");
      return { failed, skipped };
    }, CLOSE_TX);
    logServerWarning("email_campaign_scheduler.closed", "A scheduled campaign that can never be sent was closed as failed", { campaignId, code: failureReason, failed: result.failed, skipped: result.skipped });
    return "closed";
  } catch (error) {
    if (error instanceof CloseAborted) {
      if (error.outcome === "retry") logServerWarning("email_campaign_scheduler.close_deferred", "A scheduled campaign was not closed: its recipients could not be verified as permanently unsendable; it stays scheduled", { campaignId, code: failureReason });
      return error.outcome;
    }
    logServerWarning("email_campaign_scheduler.close_failed", `Closing a scheduled campaign failed (${errName(error)}); it stays scheduled`, { campaignId, code: failureReason });
    return "retry";
  }
}

/** Finds and dispatches due campaigns. Never throws for one campaign's problem; safe to call repeatedly and concurrently. */
export async function dispatchDueCampaigns(
  opts: { db?: Db; now?: Date; limit?: number; chunkSize?: number; deadlineMs?: number; unsubscribeEnv?: Record<string, string | undefined> } = {},
): Promise<DueCampaignSummary> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const started = Date.now();
  const deadline = opts.deadlineMs ?? DUE_CAMPAIGN_RUN_DEADLINE_MS;
  const limit = Number.isInteger(opts.limit) && (opts.limit as number) >= 1 ? Math.min(opts.limit as number, DUE_CAMPAIGN_MAX_LIMIT) : DUE_CAMPAIGN_DEFAULT_LIMIT;
  const staleBefore = new Date(now.getTime() - CAMPAIGN_RESUME_STALE_MS);
  const summary: DueCampaignSummary = { processed: 0, dispatched: 0, resumed: 0, skipped: 0, failed: 0, hasMore: false };

  const resumable = (take: number) => db.emailCampaign.findMany({
    where: { status: "SENDING", updatedAt: { lt: staleBefore }, recipients: { some: { status: "PENDING" } } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take,
    select: { id: true, updatedAt: true },
  });

  let candidates: Candidate[] = [];
  try {
    // One extra row tells whether more is waiting, without counting or loading everything.
    const due = await db.emailCampaign.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: now } },
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: { id: true, updatedAt: true },
    });
    if (due.length > limit) summary.hasMore = true;
    candidates = due.slice(0, limit).map((r) => ({ id: r.id, updatedAt: r.updatedAt as Date, from: "SCHEDULED" as const }));

    const room = limit - candidates.length;
    if (room > 0) {
      const stale = await resumable(room + 1);
      if (stale.length > room) summary.hasMore = true;
      candidates.push(...stale.slice(0, room).map((r) => ({ id: r.id, updatedAt: r.updatedAt as Date, from: "SENDING" as const })));
    } else if (!summary.hasMore && (await resumable(1)).length > 0) summary.hasMore = true;
  } catch (error) {
    logServerWarning("email_campaign_scheduler.select_failed", `Could not look for due campaigns (${errName(error)})`, {});
    summary.failed += 1;
    summary.processed += 1;
    return summary;
  }

  for (const c of candidates) {
    if (Date.now() - started > deadline) { summary.hasMore = true; break; }
    summary.processed += 1;
    try {
      if (!(await claim(db, c, now))) { summary.skipped += 1; continue; } // another caller has it
      const result = await dispatchEmailCampaign(c.id, { db, now, chunkSize: opts.chunkSize, unsubscribeEnv: opts.unsubscribeEnv });
      if (result.ok) {
        summary.dispatched += 1;
        if (c.from === "SENDING" || result.resumed) summary.resumed += 1;
        continue;
      }
      if (NOT_A_FAILURE.has(result.reason)) { summary.skipped += 1; continue; }
      summary.failed += 1;
      logServerWarning("email_campaign_scheduler.refused", `A due campaign was not dispatched (${result.reason})`, { campaignId: c.id, code: result.reason, resume: c.from === "SENDING" });
      const startPlan = c.from === "SCHEDULED" ? PERMANENT_AT_START.get(result.reason) : undefined;
      if (startPlan !== undefined) {
        // Nothing was queued (dispatch refused before starting). Close it so it does not stay due forever, and settle its PENDING recipients with it, in one
        // transaction that never overwrites a changed status. An unverifiable "no eligible recipients" is left SCHEDULED for the next run.
        await closeScheduledCampaign(db, c.id, result.reason, startPlan === "re-judge" ? "re-judge" : { code: startPlan }, now);
      } else if (c.from === "SENDING" && PERMANENT_ON_RESUME.has(result.reason)) {
        await settlePendingRecipients(db, c.id, PERMANENT_ON_RESUME.get(result.reason) as string, now);
      }
    } catch (error) {
      summary.failed += 1;
      logServerWarning("email_campaign_scheduler.error", `Dispatching a due campaign crashed (${errName(error)})`, { campaignId: c.id, resume: c.from === "SENDING" });
    }
  }

  if (summary.processed > 0) logServerInfo("email_campaign_scheduler.run", "Due campaigns processed", { processed: summary.processed, dispatched: summary.dispatched, resumed: summary.resumed, skipped: summary.skipped, failed: summary.failed, hasMore: summary.hasMore });
  return summary;
}
