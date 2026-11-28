import "server-only";
import { prisma } from "@/lib/db/prisma";
import { normalizeContactEmail, abandonedCartEventKey } from "@/lib/email/marketing";
import { RECOVERY_JOB_KIND, RECOVERY_SEND_BLOCK, type RecoverySendBlock } from "@/lib/email/recovery-rules";
import { safeErrorCode } from "@/lib/email/campaign-dispatch-rules";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { getContactUnsubscribeLink } from "@/server/services/email-unsubscribe.service";
import { unsubscribeHeadersFor } from "@/lib/email/unsubscribe";
import type { ListUnsubscribeHeaders } from "@/lib/email/list-unsubscribe";
import { logServerWarning } from "@/lib/logger";

type Db = typeof prisma;
type EligibilityDb = NonNullable<Parameters<typeof getMarketingEligibility>[1]>["db"];
type Env = Record<string, string | undefined>;

/**
 * The WORKER side of abandoned-cart reminders. It is called by the existing queue worker (email-queue.service) and never sends anything itself. It is the
 * recovery twin of email-campaign-delivery.service and follows the same fail-closed rules:
 *
 *  - gateRecoveryJobBeforeSend: runs right before SMTP for a job of kind "abandoned-cart". It re-runs the marketing eligibility check NOW (consent, suppression,
 *    active contact: someone who unsubscribed after the reminder was queued gets nothing), requires the job's address to still be the contact's address, proves the
 *    abandonment is still the SAME one (no new cart activity, no order since), and proves the body holds the contact's working unsubscribe URL before returning
 *    the two List-Unsubscribe headers. A "abandoned-cart" job without a RecoveryEmail row is blocked. Unverifiable = not sent.
 *  - syncRecoveryAfterJob / reconcileQueuedRecoveryEmails: copy the final state of the job onto its RecoveryEmail row (QUEUED -> SENT | FAILED). SENT is written
 *    only when the job is SENT, i.e. only after the SMTP server accepted the message.
 *  - releaseRecoveryForRetry: when an admin retries a FAILED job, its recovery row goes back FAILED -> QUEUED (conditional), so the gate lets exactly that one retry through.
 *
 * Logs carry ids and fixed codes only.
 */

export type RecoveryGate = { send: true; headers: ListUnsubscribeHeaders } | { send: false; code: RecoverySendBlock };
const elig = (db: Db) => db as unknown as EligibilityDb;
const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

export async function gateRecoveryJobBeforeSend(
  job: { id: string; kind: string; toEmail: string; text?: string | null; html?: string | null },
  opts: { db?: Db; now?: Date; unsubscribeEnv?: Env } = {},
): Promise<RecoveryGate> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.unsubscribeEnv ?? process.env;
  const rec = await db.recoveryEmail.findFirst({ where: { emailJobId: job.id }, select: { id: true, contactId: true, cartId: true, eventKey: true, status: true } });
  if (!rec) return { send: false, code: RECOVERY_SEND_BLOCK.recipientMissing };
  if (rec.status !== "QUEUED") return { send: false, code: RECOVERY_SEND_BLOCK.notQueued };

  const settle = async (data: { status: "SKIPPED" | "FAILED"; skipReason?: string; errorCode?: string }) => {
    await db.recoveryEmail.updateMany({ where: { id: rec.id, status: "QUEUED" }, data });
  };

  // 1. The address on the job must still be the contact's address, and that address must be eligible right now.
  const contact = await db.emailContact.findUnique({ where: { id: rec.contactId }, select: { email: true } });
  const jobEmail = normalizeContactEmail(job.toEmail);
  const contactEmail = contact ? normalizeContactEmail(contact.email) : null;
  const same = jobEmail.ok && contactEmail !== null && contactEmail.ok && contactEmail.email === jobEmail.email;
  const verdict = same ? await getMarketingEligibility(job.toEmail, { db: elig(db), now }) : ({ eligible: false, reason: "unverifiable" } as const);
  if (!verdict.eligible) {
    await settle({ status: "SKIPPED", skipReason: verdict.reason });
    return { send: false, code: RECOVERY_SEND_BLOCK.ineligible };
  }

  // 2. Still the same abandonment: the cart exists, its last activity is the one the reminder was queued for, and the customer has not ordered since.
  const cart = rec.cartId ? await db.cart.findUnique({ where: { id: rec.cartId }, select: { id: true, userId: true } }) : null;
  let stillAbandoned = false;
  if (cart) {
    const items = await db.cartItem.findMany({ where: { cartId: cart.id }, select: { updatedAt: true } });
    const last = items.reduce<Date | null>((m, i) => (m === null || i.updatedAt > m ? i.updatedAt : m), null);
    if (last && abandonedCartEventKey(cart.id, last) === rec.eventKey) {
      const ordered = cart.userId ? (await db.order.count({ where: { userId: cart.userId, createdAt: { gte: last } } })) > 0 : false;
      stillAbandoned = !ordered;
    }
  }
  if (!stillAbandoned) {
    await settle({ status: "SKIPPED", skipReason: RECOVERY_SEND_BLOCK.cartNoLongerAbandoned });
    return { send: false, code: RECOVERY_SEND_BLOCK.cartNoLongerAbandoned };
  }

  // 3. The unsubscribe link: no working link, or a body without it = not sent.
  const block = async (code: RecoverySendBlock): Promise<RecoveryGate> => {
    await settle({ status: "FAILED", errorCode: code });
    return { send: false, code };
  };
  const link = await getContactUnsubscribeLink(rec.contactId, { db, env });
  if (!link.ok) return block(RECOVERY_SEND_BLOCK.unsubscribeUnavailable);
  const text = typeof job.text === "string" ? job.text : "";
  const html = typeof job.html === "string" && job.html !== "" ? job.html : null;
  if (!text.includes(link.url) || (html !== null && !html.includes(link.url))) return block(RECOVERY_SEND_BLOCK.unsubscribeMissing);
  const headers = unsubscribeHeadersFor(link.url, env);
  if (!headers.ok) return block(RECOVERY_SEND_BLOCK.unsubscribeUnavailable);
  return { send: true, headers: headers.headers };
}

/** After one job reached a final state: copy it onto its recovery row (QUEUED only). Never throws. */
export async function syncRecoveryAfterJob(jobId: string, opts: { db?: Db; now?: Date } = {}): Promise<void> {
  try {
    const db = opts.db ?? prisma;
    const now = opts.now ?? new Date();
    const rec = await db.recoveryEmail.findFirst({ where: { emailJobId: jobId, status: "QUEUED" }, select: { id: true } });
    if (!rec) return;
    const job = await db.emailJob.findUnique({ where: { id: jobId }, select: { status: true, sentAt: true, errorCode: true } });
    if (!job) return;
    if (job.status === "SENT") await db.recoveryEmail.updateMany({ where: { id: rec.id, status: "QUEUED" }, data: { status: "SENT", sentAt: job.sentAt ?? now, errorCode: null } });
    else if (job.status === "FAILED") await db.recoveryEmail.updateMany({ where: { id: rec.id, status: "QUEUED" }, data: { status: "FAILED", errorCode: safeErrorCode(job.errorCode) ?? "failed" } });
  } catch (error) {
    logServerWarning("email_recovery.sync_failed", `Could not update a reminder after delivery (${errName(error)})`, { jobId });
  }
}

/** Safety net run by the queue worker: settles QUEUED reminders whose job finished without going through the worker (housekeeping expiry / out of attempts). Never throws. */
export async function reconcileQueuedRecoveryEmails(opts: { db?: Db; now?: Date; limit?: number } = {}): Promise<number> {
  const db = opts.db ?? prisma;
  let done = 0;
  try {
    const rows = await db.recoveryEmail.findMany({ where: { status: "QUEUED", emailJobId: { not: null } }, orderBy: { updatedAt: "asc" }, take: opts.limit ?? 50, select: { emailJobId: true } });
    for (const r of rows) if (r.emailJobId) { await syncRecoveryAfterJob(r.emailJobId, opts); done += 1; }
  } catch (error) {
    logServerWarning("email_recovery.sync_failed", `Could not list queued reminders (${errName(error)})`, {});
  }
  return done;
}

/** FAILED -> QUEUED for the recovery row of a job an admin is retrying. Conditional: any other state is left alone. */
export async function releaseRecoveryForRetry(jobId: string, opts: { db?: Db } = {}): Promise<void> {
  const db = opts.db ?? prisma;
  await db.recoveryEmail.updateMany({ where: { emailJobId: jobId, status: "FAILED" }, data: { status: "QUEUED", errorCode: null } });
}

export { RECOVERY_JOB_KIND };
