import "server-only";
import { prisma } from "@/lib/db/prisma";
import { isRecordId } from "@/lib/email/template-rules";
import { EMAIL_JOB_MAX_ATTEMPTS, EMAIL_MANUAL_MAX_JOBS, EMAIL_MANUAL_MAX_SELECTION } from "@/lib/email/queue-policy";
import { assessJobRetry, RETRY_REFUSAL_LABEL, type RetryAction, type RetryRefusal } from "@/lib/email/queue-retry-rules";
import { RECOVERY_JOB_KIND } from "@/lib/email/recovery-rules";
import { releaseRecoveryForRetry } from "@/server/services/email-recovery-delivery.service";
import { describeManualRun, runEmailQueueNow, type ManualRunReport } from "@/server/services/email-manual-run.service";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";
import { logServerInfo } from "@/lib/logger";

type Db = typeof prisma;
type Env = Record<string, string | undefined>;

/**
 * Admin side of the e-mail send queue: filters for Pending and Failed EmailJobs, and MANUAL retry of several selected jobs at once. There is no automatic
 * retry anywhere: a job that failed (or is waiting out a retry delay) stays exactly as it is until an admin selects it and clicks Retry.
 *
 * Retry = make the selected, eligible jobs claimable NOW with conditional updates, then run the EXISTING worker once, awaited in this request, for exactly those jobs:
 *   - never a SENT job; never a job with a fresh lock (a running send); a stale lock (older than EMAIL_PROCESSING_STALE_MS, the worker's own crash rule) can be retried;
 *   - never a job whose body was removed (nothing left to send) or that is older than 7 days;
 *   - FAILED -> PENDING is conditional on status = FAILED, so two admins clicking together release a job once, and the worker's exclusive claim makes sure only one of
 *     them sends it. Retrying gives exactly ONE more attempt (attempts is capped at MAX-1 before the run), so a retry that fails again lands in FAILED with its error
 *     code (permanent / out of attempts) or PENDING with a retry delay (temporary); it never loops;
 *   - consent, suppression, unsubscribe link and campaign/cart state are re-checked by the worker's gates right before SMTP, exactly as for a first send;
 *   - at most EMAIL_MANUAL_MAX_JOBS jobs are released and processed per click (oldest first) and the run stops when the request's time budget is used up; every
 *     selected job that was not reached is left UNTOUCHED (a FAILED one stays FAILED) and is reported, so the admin can select it again.
 */

export type JobFilter = "PENDING" | "FAILED";
export const JOBS_PAGE_SIZE = 25;

export type QueueJobRow = {
  id: string; kind: string; toEmail: string; subject: string; status: string; attempts: number;
  nextAttemptAt: string; lastAttemptAt: string | null; errorCode: string | null; errorMessage: string | null; createdAt: string;
  retryable: boolean; retryBlockedReason: string | null;
};
export type QueueListResult = { ok: true; rows: QueueJobRow[]; total: number; page: number; pageCount: number; filter: JobFilter; counts: { pending: number; failed: number }; selectionLimit: number; batchLimit: number } | { ok: false; message: string };

const deny = { ok: false as const, code: "forbidden", message: "You are not authorised to do this." };
async function actorOf(db: Db, adminId: unknown): Promise<string | null> {
  try { return await assertAdminActor(db as unknown as Parameters<typeof assertAdminActor>[0], typeof adminId === "string" ? adminId : null); } catch { return null; }
}
const iso = (d: Date | null | undefined) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

/** Newest first. The message body is never read for display; only whether it still exists decides if a job can be retried. Read-only. */
export async function adminListEmailJobs(adminId: unknown, input: { status?: unknown; page?: unknown }, opts: { db?: Db; now?: Date } = {}): Promise<QueueListResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  if (!(await actorOf(db, adminId))) return { ok: false, message: deny.message };
  const filter: JobFilter = input.status === "FAILED" ? "FAILED" : "PENDING";
  const pageNum = Number(input.page);
  const page = Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= 100_000 ? pageNum : 1;
  const [pending, failed] = await Promise.all([db.emailJob.count({ where: { status: "PENDING" } }), db.emailJob.count({ where: { status: "FAILED" } })]);
  const total = filter === "PENDING" ? pending : failed;
  const rows = await db.emailJob.findMany({
    where: { status: filter }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * JOBS_PAGE_SIZE, take: JOBS_PAGE_SIZE,
    select: { id: true, kind: true, toEmail: true, subject: true, status: true, attempts: true, nextAttemptAt: true, lastAttemptAt: true, errorCode: true, errorMessage: true, createdAt: true, lockedAt: true },
  });
  const emptyBodies = rows.length ? new Set((await db.emailJob.findMany({ where: { id: { in: rows.map((r) => r.id) }, text: "" }, select: { id: true } })).map((r) => r.id)) : new Set<string>();
  return {
    ok: true, filter, total, page, pageCount: Math.max(1, Math.ceil(total / JOBS_PAGE_SIZE)), counts: { pending, failed }, selectionLimit: EMAIL_MANUAL_MAX_SELECTION, batchLimit: EMAIL_MANUAL_MAX_JOBS,
    rows: rows.map((r) => {
      const verdict = assessJobRetry({ status: r.status, kind: r.kind, bodyRemoved: emptyBodies.has(r.id), createdAt: r.createdAt, lockedAt: r.lockedAt ?? null }, now);
      return {
        id: r.id, kind: r.kind, toEmail: r.toEmail, subject: r.subject, status: r.status, attempts: r.attempts, nextAttemptAt: iso(r.nextAttemptAt) ?? "", lastAttemptAt: iso(r.lastAttemptAt),
        errorCode: r.errorCode ?? null, errorMessage: r.errorMessage ?? null, createdAt: iso(r.createdAt) ?? "", retryable: verdict.ok, retryBlockedReason: verdict.ok ? null : RETRY_REFUSAL_LABEL[verdict.reason],
      };
    }),
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------- retry

export type RetryJobResult = { jobId: string; outcome: "sent" | "failed" | "pending" | "skipped" | "refused" | "not_processed"; reason?: string; errorCode?: string | null };
export type RetryResult =
  | { ok: true; message: string; selected: number; released: number; refused: number; notProcessed: number; delivery: (ManualRunReport & { waiting: number }) | null; results: RetryJobResult[] }
  | { ok: false; code: string; message: string };

export async function adminRetryEmailJobs(
  adminId: unknown,
  input: { jobIds?: unknown },
  opts: { db?: Db; now?: Date; smtpEnv?: Env; factory?: Parameters<typeof runEmailQueueNow>[0]["factory"]; startedAt?: number } = {},
): Promise<RetryResult> {
  const startedAt = opts.startedAt ?? Date.now();
  const db = opts.db ?? prisma;
  const actor = await actorOf(db, adminId);
  if (!actor) return deny;
  const now = opts.now ?? new Date();

  const raw = Array.isArray(input?.jobIds) ? input.jobIds : [];
  if (raw.some((x) => !isRecordId(x))) return { ok: false, code: "invalid_selection", message: "The selection contains an invalid e-mail." };
  const ids = [...new Set(raw as string[])];
  if (ids.length === 0) return { ok: false, code: "invalid_selection", message: "Select at least one e-mail." };
  if (ids.length > EMAIL_MANUAL_MAX_SELECTION) return { ok: false, code: "too_many", message: `Select at most ${EMAIL_MANUAL_MAX_SELECTION} e-mails per click.` };

  const rows = await db.emailJob.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, status: true, attempts: true, priority: true, createdAt: true, lockedAt: true } });
  const emptyBodies = new Set((await db.emailJob.findMany({ where: { id: { in: ids }, text: "" }, select: { id: true } })).map((r) => r.id));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const results: RetryJobResult[] = [];
  const refuse = (jobId: string, reason: RetryRefusal) => results.push({ jobId, outcome: "refused", reason: RETRY_REFUSAL_LABEL[reason] });
  const eligible: { id: string; kind: string; action: RetryAction; attempts: number; priority: number; createdAt: Date }[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) { refuse(id, "not_found"); continue; }
    const verdict = assessJobRetry({ status: r.status, kind: r.kind, bodyRemoved: emptyBodies.has(id), createdAt: r.createdAt, lockedAt: r.lockedAt ?? null }, now);
    if (!verdict.ok) refuse(id, verdict.reason); else eligible.push({ id, kind: r.kind, action: verdict.action, attempts: r.attempts, priority: r.priority, createdAt: r.createdAt });
  }
  // One bounded batch per click, oldest first (individual e-mail before bulk). The rest is left exactly as it is.
  eligible.sort((x, y) => x.priority - y.priority || x.createdAt.getTime() - y.createdAt.getTime());
  const batch = eligible.slice(0, EMAIL_MANUAL_MAX_JOBS);
  for (const j of eligible.slice(EMAIL_MANUAL_MAX_JOBS)) results.push({ jobId: j.id, outcome: "not_processed", reason: "Not reached in this batch: select it again to retry." });

  const stale = new Date(now.getTime() - 5 * 60_000);
  const released: typeof batch = [];
  for (const j of batch) {
    const capped = Math.min(j.attempts, EMAIL_JOB_MAX_ATTEMPTS - 1); // exactly one more attempt
    let count = 0;
    if (j.action === "release_failed") {
      count = (await db.emailJob.updateMany({ where: { id: j.id, status: "FAILED", text: { not: "" } }, data: { status: "PENDING", attempts: capped, nextAttemptAt: now, lockedAt: null } })).count;
      if (count === 1 && j.kind === RECOVERY_JOB_KIND) await releaseRecoveryForRetry(j.id, { db });
    } else if (j.action === "release_stale") {
      count = (await db.emailJob.updateMany({ where: { id: j.id, status: "PROCESSING", lockedAt: { lt: stale } }, data: { status: "PENDING", attempts: capped, nextAttemptAt: now, lockedAt: null } })).count;
    } else {
      // Still waiting out its retry delay (or already due): make it due now. Conditional on PENDING, so a job a worker just claimed is not touched.
      await db.emailJob.updateMany({ where: { id: j.id, status: "PENDING", nextAttemptAt: { gt: now } }, data: { nextAttemptAt: now } });
      count = (await db.emailJob.count({ where: { id: j.id, status: "PENDING" } }));
    }
    if (count === 1) released.push(j); else refuse(j.id, "changed");
  }

  let delivery: (ManualRunReport & { waiting: number }) | null = null;
  if (released.length) {
    const releasedIds = released.map((j) => j.id);
    const report = await runEmailQueueNow({ startedAt, jobIds: releasedIds, db, env: opts.smtpEnv, factory: opts.factory, now, maxJobs: EMAIL_MANUAL_MAX_JOBS });
    const after = await db.emailJob.findMany({ where: { id: { in: releasedIds } }, select: { id: true, status: true, errorCode: true } });
    const state = new Map(after.map((a) => [a.id, a]));
    let waiting = 0;
    for (const j of released) {
      const a = state.get(j.id);
      if (!a) { results.push({ jobId: j.id, outcome: "refused", reason: RETRY_REFUSAL_LABEL.not_found }); continue; }
      if (a.status === "SENT") results.push({ jobId: j.id, outcome: "sent" });
      else if (a.status === "FAILED") results.push({ jobId: j.id, outcome: a.errorCode === "recipient_ineligible" || a.errorCode === "cart_no_longer_abandoned" ? "skipped" : "failed", errorCode: a.errorCode });
      else { waiting += 1; results.push({ jobId: j.id, outcome: "pending", errorCode: a.errorCode }); }
    }
    delivery = { ...report, waiting };
  }

  const refused = results.filter((r) => r.outcome === "refused").length;
  const notProcessed = results.filter((r) => r.outcome === "not_processed").length;
  await recordAudit(db as unknown as Parameters<typeof recordAudit>[0], { actorId: actor, action: "email_job.retry", entityType: "EmailJob", entityId: null, detail: { selected: ids.length, released: released.length, refused, notProcessed, sent: delivery?.sent ?? 0 } }).catch(() => undefined);
  logServerInfo("email_queue.manual_retry", "Admin retried e-mail jobs", { selected: ids.length, released: released.length, sent: delivery?.sent ?? 0 });

  const sentNow = results.filter((r) => r.outcome === "sent").length;
  const bits = [`${sentNow} of ${ids.length} selected e-mail(s) sent`];
  if (refused) bits.push(`${refused} not retried (see the reason on each row)`);
  if (notProcessed) bits.push(`${notProcessed} not reached in this batch, left unchanged`);
  const run = delivery ? ` ${describeManualRun(delivery, delivery.waiting)}` : "";
  return { ok: true, selected: ids.length, released: released.length, refused, notProcessed, delivery, results, message: `${bits.join("; ")}.${run}` };
}
