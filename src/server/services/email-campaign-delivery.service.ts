import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeContactEmail } from "@/lib/email/marketing";
import {
  CAMPAIGN_JOB_KIND, CAMPAIGN_SEND_BLOCK, isCampaignFinished, safeErrorCode, type CampaignSendBlock, type DeliveryCounts,
} from "@/lib/email/campaign-dispatch-rules";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { getContactUnsubscribeLink } from "@/server/services/email-unsubscribe.service";
import { unsubscribeHeadersFor } from "@/lib/email/unsubscribe";
import type { ListUnsubscribeHeaders } from "@/lib/email/list-unsubscribe";
import { logServerWarning } from "@/lib/logger";

type Db = typeof prisma;
type EligibilityDb = NonNullable<Parameters<typeof getMarketingEligibility>[1]>["db"];

/**
 * The WORKER side of campaign e-mail (Prompt 10). It is called by the existing queue worker (email-queue.service) and never sends anything itself:
 *
 *  - gateCampaignJobBeforeSend: runs right before SMTP for a job that belongs to a campaign recipient. It re-runs the P08 marketing eligibility
 *    check NOW (so someone who unsubscribed after the audience was prepared, or after the job was queued, gets nothing) and refuses to send when
 *    the campaign is no longer SENDING or the recipient is no longer QUEUED. Unverifiable = not sent (fail closed). Only jobs of another kind (transactional
 *    e-mail) pass through untouched; a "campaign" job with no recipient row is blocked (fail closed, Prompt 11 follow-up).
 *  - reconcileCampaign: copies the final state of jobs onto their recipients (QUEUED -> SENT | FAILED), recomputes the campaign counts from the
 *    recipient rows (the single source of truth, so repeating it cannot drift) and completes the campaign only when no recipient is waiting or in
 *    flight. "Queued" is never "delivered".
 *
 * Prompt 11: for a campaign e-mail the gate ALSO proves the message has a working unsubscribe link before it may go out, and supplies the two headers:
 * it re-creates the recipient's stable link (verifying/repairing the stored hash), refuses to send when the queued text/HTML does not contain exactly
 * that URL (for example a job queued before links existed, or one queued under a different secret), and returns `List-Unsubscribe` +
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` for the SMTP send. The EmailJob row has no headers column and none was added: the headers are
 * derived here, at send time, from the same stable token, so they always match the link in the body. Non-campaign jobs get no headers and are untouched.
 *
 * This module does not import the queue service (the queue imports it), so there is no import cycle. Logs carry ids, codes and counts only.
 */

const elig = (db: Db) => db as unknown as EligibilityDb;
const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

export type SendGate = { send: true; /** Only for campaign e-mail (Prompt 11): exactly the two List-Unsubscribe headers. */ headers?: ListUnsubscribeHeaders } | { send: false; code: CampaignSendBlock };

/** Decides whether the queued e-mail may go to the SMTP server now. A thrown database error is left to the queue's own retry handling. */
export async function gateCampaignJobBeforeSend(job: { id: string; kind: string; toEmail: string; text?: string | null; html?: string | null }, opts: { db?: Db; now?: Date; unsubscribeEnv?: Record<string, string | undefined> } = {}): Promise<SendGate> {
  if (job.kind !== CAMPAIGN_JOB_KIND) return { send: true };
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();

  const recipient = await db.emailCampaignRecipient.findFirst({ where: { emailJobId: job.id }, select: { id: true, campaignId: true, contactId: true, status: true } });
  // Fail closed: a "campaign" job must belong to a campaign recipient. Without that row its recipient, eligibility and unsubscribe link cannot be verified, so it never reaches SMTP.
  if (!recipient) return { send: false, code: CAMPAIGN_SEND_BLOCK.recipientMissing };
  if (recipient.status !== "QUEUED") return { send: false, code: CAMPAIGN_SEND_BLOCK.notQueued };

  const campaign = await db.emailCampaign.findUnique({ where: { id: recipient.campaignId }, select: { status: true } });
  if (!campaign || campaign.status !== "SENDING") {
    await db.emailCampaignRecipient.updateMany({ where: { id: recipient.id, status: "QUEUED" }, data: { status: "FAILED", errorCode: CAMPAIGN_SEND_BLOCK.campaignNotActive } });
    return { send: false, code: CAMPAIGN_SEND_BLOCK.campaignNotActive };
  }

  // The address on the job must still be the address of the recipient's contact, and that address must be eligible right now.
  const contact = await db.emailContact.findUnique({ where: { id: recipient.contactId }, select: { email: true } });
  const jobEmail = normalizeContactEmail(job.toEmail);
  const contactEmail = contact ? normalizeContactEmail(contact.email) : null;
  const sameAddress = jobEmail.ok && contactEmail !== null && contactEmail.ok && contactEmail.email === jobEmail.email;
  const verdict = sameAddress ? await getMarketingEligibility(job.toEmail, { db: elig(db), now }) : ({ eligible: false, reason: "unverifiable" } as const);
  if (verdict.eligible) return gateUnsubscribeLink(job, recipient, { db, env: opts.unsubscribeEnv ?? process.env });

  await db.emailCampaignRecipient.updateMany({ where: { id: recipient.id, status: "QUEUED" }, data: { status: "SKIPPED", skipReason: verdict.reason } });
  return { send: false, code: CAMPAIGN_SEND_BLOCK.ineligible };
}

/** Prompt 11: the last check before SMTP. Fails closed: no usable link, or a body without it, means the e-mail is not sent (and the recipient becomes FAILED with a fixed code). */
async function gateUnsubscribeLink(job: { text?: string | null; html?: string | null }, recipient: { id: string; contactId: string }, opts: { db: Db; env: Record<string, string | undefined> }): Promise<SendGate> {
  const block = async (code: CampaignSendBlock): Promise<SendGate> => {
    await opts.db.emailCampaignRecipient.updateMany({ where: { id: recipient.id, status: "QUEUED" }, data: { status: "FAILED", errorCode: code } });
    return { send: false, code };
  };
  const link = await getContactUnsubscribeLink(recipient.contactId, { db: opts.db, env: opts.env });
  if (!link.ok) return block(CAMPAIGN_SEND_BLOCK.unsubscribeUnavailable);
  const text = typeof job.text === "string" ? job.text : "";
  const html = typeof job.html === "string" && job.html !== "" ? job.html : null;
  if (!text.includes(link.url) || (html !== null && !html.includes(link.url))) return block(CAMPAIGN_SEND_BLOCK.unsubscribeMissing);
  const headers = unsubscribeHeadersFor(link.url, opts.env);
  if (!headers.ok) return block(CAMPAIGN_SEND_BLOCK.unsubscribeUnavailable);
  return { send: true, headers: headers.headers };
}

export type ReconcileResult = { campaignId: string; synced: number; status: string; counts: DeliveryCounts };

const PAGE = 200;

/**
 * Brings one campaign up to date from its jobs. Idempotent and safe to run concurrently: every recipient write is conditional on status = QUEUED and
 * the counts are recomputed from the rows. Returns null when the campaign is not in a state that has counts to keep (only SENDING and CANCELLED do).
 */
export async function reconcileCampaign(campaignId: string, opts: { db?: Db; now?: Date } = {}): Promise<ReconcileResult | null> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();

  let synced = 0;
  let after = "";
  for (;;) {
    const rows = await db.emailCampaignRecipient.findMany({ where: { campaignId, status: "QUEUED", id: { gt: after } }, orderBy: { id: "asc" }, take: PAGE, select: { id: true, emailJobId: true } });
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    const jobIds = rows.map((r) => r.emailJobId).filter((id): id is string => typeof id === "string");
    const jobs = jobIds.length ? await db.emailJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, status: true, sentAt: true, errorCode: true } }) : [];
    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const row of rows) {
      const job = row.emailJobId ? byId.get(row.emailJobId) : undefined;
      let data: Prisma.EmailCampaignRecipientUpdateManyMutationInput | null = null;
      if (!job) data = { status: "FAILED", errorCode: CAMPAIGN_SEND_BLOCK.jobMissing };
      else if (job.status === "SENT") data = { status: "SENT", sentAt: job.sentAt ?? now, errorCode: null };
      else if (job.status === "FAILED") data = { status: "FAILED", errorCode: safeErrorCode(job.errorCode) ?? "failed" };
      if (!data) continue; // PENDING / PROCESSING: still in the queue, still QUEUED here
      const res = await db.emailCampaignRecipient.updateMany({ where: { id: row.id, status: "QUEUED" }, data });
      synced += res.count;
    }
  }

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const campaign = await tx.emailCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (!campaign || (campaign.status !== "SENDING" && campaign.status !== "CANCELLED")) return null;
    const count = (status?: "PENDING" | "QUEUED" | "SENT" | "FAILED" | "SKIPPED") => tx.emailCampaignRecipient.count({ where: { campaignId, ...(status ? { status } : {}) } });
    const [total, pending, queued, sent, failed, skipped] = await Promise.all([count(), count("PENDING"), count("QUEUED"), count("SENT"), count("FAILED"), count("SKIPPED")]);
    const counts: DeliveryCounts = { total, pending, queued, sent, failed, skipped };
    const finished = campaign.status === "SENDING" && isCampaignFinished(counts);
    const data = { recipientCount: total, sentCount: sent, failedCount: failed, skippedCount: skipped, ...(finished ? { status: "COMPLETED" as const, completedAt: now } : {}) };
    // Conditional on the status that was read: a campaign changed in between is left alone.
    const res = await tx.emailCampaign.updateMany({ where: { id: campaignId, status: campaign.status }, data });
    return res.count === 1 ? { campaignId, synced, status: finished ? "COMPLETED" : campaign.status, counts } : null;
  });
}

/** After one job reached a final state: refresh the campaign its recipient belongs to. Never throws (the queue must not fail because of this). */
export async function syncCampaignAfterJob(jobId: string, opts: { db?: Db; now?: Date } = {}): Promise<void> {
  try {
    const db = opts.db ?? prisma;
    const recipient = await db.emailCampaignRecipient.findFirst({ where: { emailJobId: jobId }, select: { campaignId: true } });
    if (recipient) await reconcileCampaign(recipient.campaignId, opts);
  } catch (error) {
    logServerWarning("email_campaign.sync_failed", `Could not update a campaign after delivery (${errName(error)})`, { jobId });
  }
}

/** Safety net run by the queue worker: refreshes campaigns that are SENDING (covers jobs the queue's housekeeping failed or expired). Never throws. */
export async function reconcileSendingCampaigns(opts: { db?: Db; now?: Date; limit?: number } = {}): Promise<number> {
  const db = opts.db ?? prisma;
  let done = 0;
  try {
    const campaigns = await db.emailCampaign.findMany({ where: { status: "SENDING" }, orderBy: { updatedAt: "asc" }, take: opts.limit ?? 20, select: { id: true } });
    for (const c of campaigns) {
      try { if (await reconcileCampaign(c.id, opts)) done += 1; } catch (error) { logServerWarning("email_campaign.sync_failed", `Could not update a campaign (${errName(error)})`, { campaignId: c.id }); }
    }
  } catch (error) {
    logServerWarning("email_campaign.sync_failed", `Could not list sending campaigns (${errName(error)})`, {});
  }
  return done;
}
