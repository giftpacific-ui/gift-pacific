import "server-only";
import { prisma } from "@/lib/db/prisma";
import { processEmailQueue, type EmailQueueSummary } from "@/server/services/email-queue.service";
import type { TransportFactory } from "@/lib/email/smtp";
import { EMAIL_MANUAL_MAX_JOBS, manualSendDeadlineMs } from "@/lib/email/queue-policy";
import { logServerWarning } from "@/lib/logger";

type Db = typeof prisma;
type Env = Record<string, string | undefined>;

/**
 * THE ONE place an admin click turns queued e-mail into sent e-mail (Send now, Continue sending, Send reminders, Retry). It calls the EXISTING
 * processEmailQueue exactly once and AWAITS it, inside the request that was clicked:
 *
 *   - bounded: at most EMAIL_MANUAL_MAX_JOBS sends (and never more than the existing batch size / hourly / daily limits allow), and the loop stops starting
 *     sends when the request's time budget is used up (manualSendDeadlineMs), so one invocation always ends inside the page's `maxDuration = 60`;
 *   - scoped: only the jobs the click is about (`jobIds`), so clicking one campaign never sends another campaign's backlog;
 *   - honest: whatever did not fit stays PENDING and is reported as "waiting"; nothing is promised to continue after the response. No timer, no setInterval,
 *     no after(), no un-awaited promise: when this function returns, the work it did is finished and recorded;
 *   - safe: every send still goes through deliverEmailJob (claim, consent/suppression/unsubscribe gate, SMTP, SENT only after SMTP accepted).
 *
 * A failure of the run itself (for example a database error) is caught and reported as "error": the e-mails were already queued, are untouched and can be sent
 * with the next click.
 */

export type ManualRunReport = {
  /** processEmailQueue was actually called and returned. */
  ran: boolean;
  reason: "ok" | "no_time" | "nothing_to_send" | "error";
  smtpReady: boolean;
  attempted: number;
  sent: number;
  failed: number;
  retryScheduled: number;
  deferred: number;
  skipped: number;
  halted: EmailQueueSummary["halted"];
};

const EMPTY: Omit<ManualRunReport, "reason" | "ran"> = { smtpReady: false, attempted: 0, sent: 0, failed: 0, retryScheduled: 0, deferred: 0, skipped: 0, halted: null };

export async function runEmailQueueNow(opts: {
  /** Date.now() taken when the admin request began; the time already used (dispatch, audits) is subtracted from the send budget. */
  startedAt: number;
  jobIds?: readonly string[];
  db?: Db;
  env?: Env;
  factory?: TransportFactory;
  now?: Date;
  maxJobs?: number;
}): Promise<ManualRunReport> {
  if (opts.jobIds && opts.jobIds.length === 0) return { ...EMPTY, ran: false, reason: "nothing_to_send" };
  const deadlineMs = manualSendDeadlineMs(Date.now() - opts.startedAt);
  if (deadlineMs <= 0) return { ...EMPTY, ran: false, reason: "no_time", halted: "time_limit" };
  try {
    const summary = await processEmailQueue({
      db: opts.db, env: opts.env, factory: opts.factory, now: opts.now,
      jobIds: opts.jobIds, deadlineMs,
      maxJobs: Math.min(EMAIL_MANUAL_MAX_JOBS, opts.maxJobs ?? EMAIL_MANUAL_MAX_JOBS),
    });
    return {
      ran: true, reason: "ok", smtpReady: summary.smtpReady, attempted: summary.attempted, sent: summary.sent, failed: summary.failed,
      retryScheduled: summary.retryScheduled, deferred: summary.deferred, skipped: summary.skipped, halted: summary.halted,
    };
  } catch (error) {
    logServerWarning("email_manual_run.failed", `The e-mail queue run failed (${error instanceof Error ? error.name : "unknown"})`, {});
    return { ...EMPTY, ran: false, reason: "error" };
  }
}

/**
 * Plain-language result of one run. `waiting` = how many of the e-mails this click was about are still PENDING (not sent, not failed). The text never
 * says that anything continues in the background, because nothing does.
 */
export function describeManualRun(report: ManualRunReport, waiting: number): string {
  const tail = waiting > 0 ? ` ${waiting} e-mail(s) are still waiting (Pending). Nothing is sent in the background: use the button again to send the next batch.` : "";
  if (report.reason === "nothing_to_send") return `Nothing was sent.${tail}`;
  if (report.reason === "no_time") return `Nothing was sent in this request because the time budget was used up.${tail}`;
  if (report.reason === "error") return `The e-mails are queued but could not be sent just now (a temporary problem). They stay Pending; try again in a moment.${tail}`;
  if (!report.smtpReady) return `The e-mails are queued, but SMTP is not configured, so nothing was sent. They stay Pending.${tail}`;
  const parts = [`${report.sent} sent`];
  if (report.failed) parts.push(`${report.failed} failed`);
  if (report.retryScheduled) parts.push(`${report.retryScheduled} temporarily failed (still Pending)`);
  if (report.skipped) parts.push(`${report.skipped} skipped (recipient no longer eligible)`);
  if (report.deferred) parts.push(`${report.deferred} held back by an SMTP setup problem`);
  const why = report.halted === "time_limit" ? " The time limit for one request was reached." : report.halted === "smtp_problem" ? " Sending stopped because of an SMTP setup problem." : "";
  return `${parts.join(", ")}.${why}${tail}`;
}
