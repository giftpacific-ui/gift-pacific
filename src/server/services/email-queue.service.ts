import "server-only";
import { after } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { parseSmtpConfig } from "@/lib/email/config";
import { sendSmtpMail, type TransportFactory } from "@/lib/email/smtp";
import {
  EMAIL_ENQUEUE_CHUNK,
  EMAIL_FAILED_RETENTION_MS,
  EMAIL_INTERNAL_RETRY_MS,
  EMAIL_JOB_MAX_AGE_MS,
  EMAIL_JOB_MAX_ATTEMPTS,
  EMAIL_MAX_BULK_ENQUEUE,
  EMAIL_PRIORITY,
  EMAIL_PROCESSING_STALE_MS,
  EMAIL_RUN_DEADLINE_MS,
  EMAIL_SENT_RETENTION_MS,
  EMAIL_SYSTEMIC_PAUSE_MS,
  classifyEmailFailure,
  emailSendBudget,
  nextEmailRetryDelayMs,
  parseEmailQueueLimits,
  validateEmailJobInput,
  type EmailJobInput,
  type EmailPriority,
  type ValidEmailJob,
} from "@/lib/email/queue-policy";
import { logServerInfo, logServerWarning } from "@/lib/logger";
import { CAMPAIGN_JOB_KIND } from "@/lib/email/campaign-dispatch-rules";
import { RECOVERY_JOB_KIND } from "@/lib/email/recovery-rules";
import { stripDesignMarker } from "@/lib/email/designer/marker";
import type { ListUnsubscribeHeaders } from "@/lib/email/list-unsubscribe";
import {
  gateCampaignJobBeforeSend,
  reconcileSendingCampaigns,
  syncCampaignAfterJob,
} from "@/server/services/email-campaign-delivery.service";
import {
  gateRecoveryJobBeforeSend,
  reconcileQueuedRecoveryEmails,
  syncRecoveryAfterJob,
} from "@/server/services/email-recovery-delivery.service";

/**
 * Prompt 11: a CAMPAIGN job's body contains the recipient's unsubscribe link (with its token) until the job is settled. SENT, gate-blocked and expired jobs
 * already drop it; this is applied to the other TERMINAL failure paths of campaign jobs too, so a finished job never keeps a token. Terminal means no
 * retry will ever read the body (the worker only claims PENDING jobs). Never applied to a job that stays PENDING for a retry, and never to other kinds.
 */
const DROP_BODY = { text: "", html: null } as const;

/**
 * E-mail queue (P7.3.3): the ONE way to send e-mail that must not block a request, may be retried, or goes to many people.
 *
 *   caller -> enqueueEmail / enqueueEmails   PERSIST rows (PENDING); a few fast inserts, no SMTP, no waiting     [fast, reliable]
 *          -> single e-mail only: best-effort kick with after() (runs after the response)
 *   worker -> processEmailQueue drains PENDING rows within the send limits. It runs ONLY when something explicitly calls it: an admin's Send now / Continue
 *             sending / Send reminders / Retry click (src/server/services/email-manual-run.service, bounded by EMAIL_MANUAL_MAX_JOBS and the request time budget,
 *             awaited inside that request) or the PROTECTED POST /api/email/queue route (Bearer CRON_SECRET), which nothing in this project schedules.
 *
 * Existing infrastructure reused (nothing second was built): PostgreSQL + Prisma, the external-scheduler + CRON_SECRET contract used by
 * /api/tracking/retry and /api/courier/reconcile, the claim/retry lifecycle of TrackingEventLog, `sendSmtpMail` (the only SMTP send function)
 * and `logServerWarning/Info`. No Redis, no worker process, no new dependency.
 *
 * Guarantees (tests/services/email-queue.test.ts):
 *  - Same logical e-mail = one row: unique `dedupeKey` + createMany skipDuplicates (also under concurrent enqueues).
 *  - A row is claimed by exactly one worker (conditional UPDATE); a crashed claim is re-claimable after EMAIL_PROCESSING_STALE_MS.
 *  - States: PENDING -> PROCESSING -> SENT | FAILED (a retry goes back to PENDING with a later nextAttemptAt).
 *  - Temporary failures retry with backoff, at most EMAIL_JOB_MAX_ATTEMPTS; permanent ones fail at once; a broken SMTP setup pauses the queue
 *    instead of burning attempts.
 *  - Sending is limited per run, per hour and per day; individual e-mails drain before bulk.
 *  - Errors keep only fixed codes/messages; logs hold the job id, kind, code and attempt: never an address, subject, body or secret.
 *
 * DELIVERY IS AT-LEAST-ONCE: if a worker dies after the SMTP server accepted a message but before the row is marked SENT, the stale claim is retried and
 * the recipient can receive it twice. SMTP has no way to prevent that; the window is one database write wide.
 */

type Db = typeof prisma;
type Env = Record<string, string | undefined>;
type Common = { now?: Date; db?: Db; env?: Env; factory?: TransportFactory };

export type EmailOutcome =
  | "sent"
  | "retry_scheduled"
  | "failed"
  | "deferred"
  | "skipped"
  | "not_claimed"
  | "not_found";

const MAX = EMAIL_JOB_MAX_ATTEMPTS;

/** Rows a worker may claim now: PENDING and due, or PROCESSING with a stale claim (crashed worker) that still has attempts left. */
const claimable = (now: Date) => ({
  OR: [
    {
      status: "PENDING" as const,
      nextAttemptAt: { lte: now },
      attempts: { lt: MAX },
    },
    {
      status: "PROCESSING" as const,
      lockedAt: { lt: new Date(now.getTime() - EMAIL_PROCESSING_STALE_MS) },
      attempts: { lt: MAX },
    },
  ],
});

const errName = (error: unknown) =>
  error instanceof Error ? error.name : "unknown";

// ------------------------------------------------------------------------------------------------------------------------------------ enqueue

export type EnqueueResult =
  | { ok: true; jobId: string; created: boolean }
  | { ok: false; message: string };

/**
 * Queues ONE e-mail. Idempotent: queueing the same (kind, dedupeParts) again returns the existing job with `created: false` and sends nothing more.
 * Never throws (a failed enqueue must not break the checkout/order flow that asked for the e-mail). `kick` (default true) schedules one best-effort
 * send with after(); if that never runs, the queue worker sends it.
 */
export async function enqueueEmail(
  input: EmailJobInput,
  opts: Common & { priority?: EmailPriority; kick?: boolean } = {},
): Promise<EnqueueResult> {
  const checked = validateEmailJobInput(input);
  if (!checked.ok) return { ok: false, message: checked.message };
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  try {
    const created = await db.emailJob.createMany({
      data: [toRow(checked.job, opts.priority ?? "transactional", now)],
      skipDuplicates: true,
    });
    const row = await db.emailJob.findUnique({
      where: { dedupeKey: checked.job.dedupeKey },
      select: { id: true },
    });
    if (!row) return { ok: false, message: "The e-mail could not be queued." };
    if (created.count === 1 && opts.kick !== false) kickDelivery(row.id, opts);
    return { ok: true, jobId: row.id, created: created.count === 1 };
  } catch (error) {
    logServerWarning(
      "email_queue.enqueue_failed",
      `Could not queue an e-mail (${errName(error)})`,
      { kind: checked.job.kind },
    );
    return { ok: false, message: "The e-mail could not be queued." };
  }
}

export type BulkEnqueueResult =
  | {
      ok: true;
      queued: number;
      duplicates: number;
      invalid: { index: number; message: string }[];
    }
  | { ok: false; message: string };

/**
 * Queues MANY e-mails with a handful of inserts and returns at once: nothing is sent here, so the request that asked for it never waits for SMTP.
 * Invalid entries are reported by position and skipped; the rest are queued. Duplicates (inside the list or already queued) are counted, not
 * inserted. Safe to call again with the same list after a failure: whatever was already queued is simply a duplicate. Bulk jobs drain after
 * individual ones. At most EMAIL_MAX_BULK_ENQUEUE entries per call.
 */
export async function enqueueEmails(
  inputs: readonly EmailJobInput[],
  opts: Common & { priority?: EmailPriority } = {},
): Promise<BulkEnqueueResult> {
  if (!Array.isArray(inputs) || inputs.length === 0)
    return { ok: true, queued: 0, duplicates: 0, invalid: [] };
  if (inputs.length > EMAIL_MAX_BULK_ENQUEUE)
    return {
      ok: false,
      message: `Queue at most ${EMAIL_MAX_BULK_ENQUEUE} e-mails per call.`,
    };
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const priority = opts.priority ?? "bulk";

  const invalid: { index: number; message: string }[] = [];
  const valid: ValidEmailJob[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  inputs.forEach((input, index) => {
    const checked = validateEmailJobInput(input);
    if (!checked.ok) {
      invalid.push({ index, message: checked.message });
      return;
    }
    if (seen.has(checked.job.dedupeKey)) {
      duplicates += 1;
      return;
    }
    seen.add(checked.job.dedupeKey);
    valid.push(checked.job);
  });

  let queued = 0;
  try {
    for (let i = 0; i < valid.length; i += EMAIL_ENQUEUE_CHUNK) {
      const chunk = valid.slice(i, i + EMAIL_ENQUEUE_CHUNK);
      const r = await db.emailJob.createMany({
        data: chunk.map((job) => toRow(job, priority, now)),
        skipDuplicates: true,
      });
      queued += r.count;
      duplicates += chunk.length - r.count;
    }
  } catch (error) {
    logServerWarning(
      "email_queue.bulk_enqueue_failed",
      `Could not queue e-mails (${errName(error)})`,
      { queued, requested: inputs.length },
    );
    return {
      ok: false,
      message:
        "The e-mails could not be queued. Nothing is lost by trying again: already queued entries are skipped.",
    };
  }
  return { ok: true, queued, duplicates, invalid };
}

function toRow(job: ValidEmailJob, priority: EmailPriority, now: Date) {
  return {
    kind: job.kind,
    dedupeKey: job.dedupeKey,
    priority: EMAIL_PRIORITY[priority],
    toEmail: job.toEmail,
    subject: job.subject,
    text: job.text,
    html: job.html,
    status: "PENDING" as const,
    attempts: 0,
    nextAttemptAt: now,
  };
}

/** Best-effort send of one just-queued job after the response. Skipped when SMTP is not ready (the job simply waits). Never throws. */
function kickDelivery(jobId: string, opts: Common) {
  try {
    after(async () => {
      try {
        if (parseSmtpConfig(opts.env ?? process.env).status !== "ready") return;
        await deliverEmailJob(jobId, opts);
      } catch {
        // the queue worker sends it
      }
    });
  } catch {
    // Called outside a request scope (or after() unavailable): the queue worker sends it.
  }
}

// ------------------------------------------------------------------------------------------------------------------------------------ deliver

/** Attempts one job: claim -> send -> SENT | retry | FAILED. Exactly one caller wins the claim. Never throws. */
export async function deliverEmailJob(
  jobId: string,
  opts: Common = {},
): Promise<EmailOutcome> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  try {
    const claimed = await db.emailJob.updateMany({
      where: { id: jobId, ...claimable(now) },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lockedAt: now,
        lastAttemptAt: now,
      },
    });
    if (claimed.count !== 1) return "not_claimed";

    const job = await db.emailJob.findUnique({ where: { id: jobId } });
    if (!job) return "not_found";
    const settle = (data: Record<string, unknown>) =>
      db.emailJob.updateMany({
        where: { id: jobId, status: "PROCESSING" },
        data: { lockedAt: null, ...data },
      });
    // Prompt 10: a CAMPAIGN e-mail is re-checked against current marketing eligibility right before SMTP (unsubscribed or suppressed since it was
    // queued = not sent). Every job of another kind passes through exactly as before; a "campaign"-labelled job without a recipient row is blocked (fail closed).
    const isCampaign = job.kind === CAMPAIGN_JOB_KIND;
    // Abandoned-cart reminders are marketing/recovery e-mail too: they get the same fail-closed gate (consent, suppression, unsubscribe link and headers).
    const isRecovery = job.kind === RECOVERY_JOB_KIND;
    const sync = async () => {
      if (isCampaign) await syncCampaignAfterJob(jobId, { db, now });
      else if (isRecovery) await syncRecoveryAfterJob(jobId, { db, now });
    };
    let headers: ListUnsubscribeHeaders | undefined; // Prompt 11: List-Unsubscribe headers, for campaign / recovery e-mail only (derived by the gate, not stored on the job)
    if (isCampaign || isRecovery) {
      const gate = isCampaign ? await gateCampaignJobBeforeSend(job, { db, now }) : await gateRecoveryJobBeforeSend(job, { db, now });
      if (!gate.send) {
        await settle({
          status: "FAILED",
          errorCode: gate.code,
          errorMessage:
            "Not sent: the recipient, campaign or cart no longer allows this e-mail.",
          text: "",
          html: null,
        });
        logServerInfo("email_queue.skipped", "Marketing e-mail not sent", {
          jobId,
          kind: job.kind,
          code: gate.code,
        });
        await sync();
        return "skipped";
      }
      headers = gate.headers;
    }

    const result = await sendSmtpMail(
      {
        to: job.toEmail,
        subject: job.subject,
        text: job.text,
        // P12-UI-02: last line of defence for jobs queued before the designer marker was kept out of campaign e-mail.
        ...(job.html ? { html: stripDesignMarker(job.html) } : {}),
        ...(headers ? { headers } : {}),
      },
      env,
      opts.factory,
    );

    if (result.ok) {
      // The body has done its job: remove it now, keep the row as the audit trail until the retention window ends.
      await settle({
        status: "SENT",
        sentAt: now,
        messageId: result.messageId,
        errorCode: null,
        errorMessage: null,
        text: "",
        html: null,
      });
      logServerInfo("email_queue.sent", "E-mail accepted by the SMTP server", {
        jobId,
        kind: job.kind,
        attempt: job.attempts,
      });
      await sync();
      return "sent";
    }

    const fields = {
      errorCode: result.code,
      errorMessage: result.message.slice(0, 300),
    };
    const kind = classifyEmailFailure(result.code);
    if (kind === "permanent") {
      await settle({
        status: "FAILED",
        ...fields,
        ...(isCampaign ? DROP_BODY : {}),
      });
      logServerWarning(
        "email_queue.failed",
        `E-mail failed permanently (${result.code})`,
        { jobId, kind: job.kind, attempt: job.attempts, code: result.code },
      );
      await sync();
      return "failed";
    }
    if (kind === "systemic") {
      // Not this e-mail's fault: give the attempt back and wait for an operator to fix the SMTP setup.
      await settle({
        status: "PENDING",
        attempts: { decrement: 1 },
        nextAttemptAt: new Date(now.getTime() + EMAIL_SYSTEMIC_PAUSE_MS),
        ...fields,
      });
      logServerWarning(
        "email_queue.paused",
        `SMTP setup problem (${result.code}); e-mail kept queued`,
        { jobId, kind: job.kind, code: result.code },
      );
      return "deferred";
    }
    const delay = nextEmailRetryDelayMs(job.attempts);
    if (delay === null) {
      await settle({
        status: "FAILED",
        ...fields,
        ...(isCampaign ? DROP_BODY : {}),
      });
      logServerWarning(
        "email_queue.failed",
        `E-mail failed after ${job.attempts} attempts (${result.code})`,
        { jobId, kind: job.kind, attempt: job.attempts, code: result.code },
      );
      await sync();
      return "failed";
    }
    await settle({
      status: "PENDING",
      nextAttemptAt: new Date(now.getTime() + delay),
      ...fields,
    });
    logServerWarning(
      "email_queue.retry",
      `E-mail attempt failed (${result.code}); retry scheduled`,
      {
        jobId,
        kind: job.kind,
        attempt: job.attempts,
        code: result.code,
        retryInSeconds: Math.round(delay / 1000),
      },
    );
    return "retry_scheduled";
  } catch (error) {
    // Unexpected (database hiccup, bug). Release the claim; the error text is NOT stored or logged (only its class).
    logServerWarning(
      "email_queue.internal_error",
      `Delivery crashed (${errName(error)})`,
      { jobId },
    );
    try {
      const row = await db.emailJob.findUnique({
        where: { id: jobId },
        select: { attempts: true, status: true, kind: true },
      });
      if (row?.status === "PROCESSING") {
        const exhausted = row.attempts >= MAX;
        await db.emailJob.updateMany({
          where: { id: jobId, status: "PROCESSING" },
          data: {
            lockedAt: null,
            errorCode: exhausted ? "attempts_exhausted" : "internal",
            errorMessage: exhausted
              ? `Gave up after ${MAX} attempts.`
              : "Unexpected error while sending; it will be retried.",
            ...(exhausted
              ? {
                  status: "FAILED",
                  ...(row.kind === CAMPAIGN_JOB_KIND ? DROP_BODY : {}),
                }
              : {
                  status: "PENDING",
                  nextAttemptAt: new Date(
                    now.getTime() + EMAIL_INTERNAL_RETRY_MS,
                  ),
                }),
          },
        });
      }
    } catch {
      // The stale-claim rule recovers it.
    }
    return "retry_scheduled";
  }
}

// ------------------------------------------------------------------------------------------------------------------------------------- worker

export type EmailQueueSummary = {
  smtpReady: boolean;
  /** Sends this run was allowed to start (after the batch size and the hourly/daily budget). 0 = throttled or nothing allowed. */
  budget: number;
  attempted: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  deferred: number;
  /** Campaign e-mails deliberately not sent because the recipient or campaign no longer allowed it (Prompt 10). No SMTP attempt was made. */
  skipped: number;
  /** The run stopped early: a system-wide SMTP problem, or the time limit. */
  halted: "smtp_problem" | "time_limit" | null;
  housekeeping: { expired: number; exhausted: number; purged: number };
  queue: { pending: number; failed: number };
};

/**
 * Drains the queue: the GUARANTEED sender. Called by POST /api/email/queue (external scheduler) and usable from a script.
 *  1. housekeeping: expire jobs queued for over a week, fail jobs that ran out of attempts, delete old finished rows;
 *  2. leave everything PENDING when SMTP is not configured/valid (no attempt is used up);
 *  3. work out the budget: batch size, minus what was already sent in the last hour/day;
 *  4. send due jobs one after another (individual before bulk, oldest first), stopping at a system-wide SMTP problem or the time limit.
 * Overlapping runs are safe: each job is claimed by exactly one of them.
 */
export async function processEmailQueue(
  opts: Common & {
    deadlineMs?: number;
    /** Admin-triggered runs: start at most this many sends in this call (on top of the batch size and the hourly/daily limits). */
    maxJobs?: number;
    /** Admin-triggered runs: work ONLY on these jobs (and only while they are PENDING and due). Omitted = the whole queue, oldest first. */
    jobIds?: readonly string[];
  } = {},
): Promise<EmailQueueSummary> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const started = Date.now();
  const deadline = opts.deadlineMs ?? EMAIL_RUN_DEADLINE_MS;
  const summary: EmailQueueSummary = {
    smtpReady: false,
    budget: 0,
    attempted: 0,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    deferred: 0,
    skipped: 0,
    halted: null,
    housekeeping: { expired: 0, exhausted: 0, purged: 0 },
    queue: { pending: 0, failed: 0 },
  };

  summary.housekeeping = await housekeeping(db, now);

  summary.smtpReady = parseSmtpConfig(env).status === "ready";
  if (summary.smtpReady) {
    const limits = parseEmailQueueLimits(env);
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const [lastHour, lastDay] = await Promise.all([
      db.emailJob.count({
        where: { status: "SENT", sentAt: { gte: hourAgo } },
      }),
      db.emailJob.count({ where: { status: "SENT", sentAt: { gte: dayAgo } } }),
    ]);
    summary.budget = emailSendBudget(limits, lastHour, lastDay);
    if (Number.isInteger(opts.maxJobs) && (opts.maxJobs as number) >= 0) summary.budget = Math.min(summary.budget, opts.maxJobs as number);

    if (summary.budget > 0) {
      const scope = opts.jobIds ? { id: { in: [...opts.jobIds] }, status: "PENDING" as const } : null;
      const due = await db.emailJob.findMany({
        where: scope ? { AND: [claimable(now), scope] } : claimable(now),
        select: { id: true },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: summary.budget,
      });
      for (const row of due) {
        if (Date.now() - started > deadline) {
          summary.halted = "time_limit";
          break;
        }
        const outcome = await deliverEmailJob(row.id, {
          now,
          db,
          env,
          factory: opts.factory,
        });
        if (outcome === "not_claimed" || outcome === "not_found") continue; // another worker took it
        if (outcome === "skipped") {
          summary.skipped += 1;
          continue;
        } // not an SMTP attempt: it uses no part of the send budget
        summary.attempted += 1;
        if (outcome === "sent") summary.sent += 1;
        else if (outcome === "failed") summary.failed += 1;
        else if (outcome === "retry_scheduled") summary.retryScheduled += 1;
        else if (outcome === "deferred") {
          summary.deferred += 1;
          summary.halted = "smtp_problem";
          break;
        }
      }
    }
  }

  // Prompt 10 safety net: settle campaigns whose jobs finished in housekeeping (expired / out of attempts). Never throws; touches no e-mail job.
  await reconcileSendingCampaigns({ db, now });
  await reconcileQueuedRecoveryEmails({ db, now });

  const [pending, failed] = await Promise.all([
    db.emailJob.count({ where: { status: "PENDING" } }),
    db.emailJob.count({ where: { status: "FAILED" } }),
  ]);
  summary.queue = { pending, failed };
  if (summary.attempted > 0 || summary.halted)
    logServerInfo("email_queue.run", "E-mail queue run finished", {
      attempted: summary.attempted,
      sent: summary.sent,
      failed: summary.failed,
      retry: summary.retryScheduled,
      halted: summary.halted,
    });
  return summary;
}

async function housekeeping(db: Db, now: Date) {
  const stale = new Date(now.getTime() - EMAIL_PROCESSING_STALE_MS);
  // Too old to be worth sending: the body is removed (it will never be used).
  const expired = await db.emailJob.updateMany({
    where: {
      status: "PENDING",
      createdAt: { lt: new Date(now.getTime() - EMAIL_JOB_MAX_AGE_MS) },
    },
    data: {
      status: "FAILED",
      lockedAt: null,
      errorCode: "expired",
      errorMessage: "Not sent: it stayed queued for more than 7 days.",
      text: "",
      html: null,
    },
  });
  // Ran out of attempts without a clean result (for example a worker that kept crashing mid-send): stop, do not send again.
  const exhaustedWhere = {
    OR: [
      { status: "PENDING" as const, attempts: { gte: MAX } },
      { status: "PROCESSING" as const, lockedAt: { lt: stale }, attempts: { gte: MAX } },
    ],
  };
  const exhaustedData = {
    status: "FAILED" as const,
    lockedAt: null,
    errorCode: "attempts_exhausted",
    errorMessage: `Gave up after ${MAX} attempts.`,
  };
  // Prompt 11: for campaign jobs the (now never used) body, which holds the unsubscribe link, is dropped too; every other kind is updated exactly as before.
  const exhaustedCampaign = await db.emailJob.updateMany({
    where: { kind: CAMPAIGN_JOB_KIND, ...exhaustedWhere },
    data: { ...exhaustedData, ...DROP_BODY },
  });
  const exhaustedOther = await db.emailJob.updateMany({
    where: { kind: { not: CAMPAIGN_JOB_KIND }, ...exhaustedWhere },
    data: exhaustedData,
  });
  const exhausted = { count: exhaustedCampaign.count + exhaustedOther.count };
  const sentOld = await db.emailJob.deleteMany({
    where: {
      status: "SENT",
      sentAt: { lt: new Date(now.getTime() - EMAIL_SENT_RETENTION_MS) },
    },
  });
  const failedOld = await db.emailJob.deleteMany({
    where: {
      status: "FAILED",
      createdAt: { lt: new Date(now.getTime() - EMAIL_FAILED_RETENTION_MS) },
    },
  });
  return {
    expired: expired.count,
    exhausted: exhausted.count,
    purged: sentOld.count + failedOld.count,
  };
}
