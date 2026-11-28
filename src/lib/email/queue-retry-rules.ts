/**
 * Manual retry rules for EmailJobs. PURE: no database, no network. Decides which jobs an admin may retry from the send queue page and what "retry" means for each.
 * Retrying NEVER bypasses the sending pipeline: a retried job goes back to PENDING and is then claimed and sent by the EXISTING worker (claim, consent /
 * suppression / unsubscribe gate for marketing e-mail, SMTP, SENT only after SMTP accepted).
 */
import { CAMPAIGN_JOB_KIND } from "@/lib/email/campaign-dispatch-rules";
import { EMAIL_JOB_MAX_AGE_MS, EMAIL_PROCESSING_STALE_MS } from "@/lib/email/queue-policy";

export const RETRY_REFUSAL_LABEL = {
  not_found: "The e-mail no longer exists",
  sent: "Already sent: a sent e-mail is never sent again",
  in_progress: "Being processed right now (locked by a running send)",
  body_removed: "The message body was removed after the failure, so it cannot be sent again from here",
  too_old: "Queued for more than 7 days: too old to send",
  campaign_failed: "A failed campaign e-mail is not retried one by one (its campaign recipient is already settled)",
  changed: "Changed by someone else while retrying: reload and check its state",
  not_retryable: "This e-mail is not in a retryable state",
} as const;
export type RetryRefusal = keyof typeof RETRY_REFUSAL_LABEL;

export type RetryAction = "release_failed" | "run_pending" | "release_stale";
export type RetryAssessment = { ok: true; action: RetryAction } | { ok: false; reason: RetryRefusal };

export type RetryJobFacts = {
  status: string;
  kind: string;
  /** The stored text body is the empty string (removed after SENT, after a gate block, or after a terminal campaign failure). */
  bodyRemoved: boolean;
  createdAt: Date;
  lockedAt: Date | null;
};

export function assessJobRetry(job: RetryJobFacts, now: Date): RetryAssessment {
  if (job.status === "SENT") return { ok: false, reason: "sent" };
  if (job.status === "PROCESSING") {
    // A claim older than the stale window is a crashed worker (the same rule the worker itself uses); a fresh one is a running send.
    const stale = job.lockedAt instanceof Date && job.lockedAt.getTime() < now.getTime() - EMAIL_PROCESSING_STALE_MS;
    return stale ? { ok: true, action: "release_stale" } : { ok: false, reason: "in_progress" };
  }
  if (job.status !== "PENDING" && job.status !== "FAILED") return { ok: false, reason: "not_retryable" };
  if (job.status === "FAILED" && job.kind === CAMPAIGN_JOB_KIND) return { ok: false, reason: "campaign_failed" };
  if (job.bodyRemoved) return { ok: false, reason: "body_removed" };
  if (job.createdAt.getTime() < now.getTime() - EMAIL_JOB_MAX_AGE_MS) return { ok: false, reason: "too_old" };
  return { ok: true, action: job.status === "FAILED" ? "release_failed" : "run_pending" };
}
