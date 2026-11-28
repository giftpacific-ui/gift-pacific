import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { MARKETING_SKIP_REASONS, type MarketingSkipReason } from "@/lib/email/marketing";
import { isCampaignEditable } from "@/lib/email/campaign-rules";
import { isRecordId } from "@/lib/email/template-rules";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";

type Db = typeof prisma;
type EligibilityDb = NonNullable<Parameters<typeof getMarketingEligibility>[1]>["db"];

/**
 * Campaign audience preparation (Prompt 09). Builds the audience SNAPSHOT of a DRAFT campaign as EmailCampaignRecipient rows (status PENDING,
 * `consentId` = the consent that made the contact eligible). It never sends, never creates or queues an EmailJob and never changes a contact,
 * consent or suppression.
 *
 * Eligibility is NEVER taken from the caller: every contact is judged by the P08 getMarketingEligibility, inside the same transaction that writes
 * the row. Not eligible for ANY reason (no consent, unsubscribed, suppressed, bounced, complained, inactive, invalid address, or the check could not
 * be completed) means no recipient row. Existing PENDING rows are re-checked on every run, and one that is no longer eligible is marked SKIPPED with
 * the fixed skip reason (the row, its consent reference and its history are kept; nothing else about it is rewritten), so a re-run cannot leave a stale audience. The sender must still re-check at send time (consent can change
 * after the snapshot).
 *
 * Work is done in chunks, one transaction per chunk (an interactive transaction has a time limit). The run as a whole is therefore not atomic, but
 * each chunk is, and the run is idempotent: after a failure, run it again. Duplicates are impossible: (campaignId, contactId) is unique, rows are
 * written with createMany(skipDuplicates) and existing rows are never rewritten except as described above.
 */

const DEFAULT_CHUNK = 200;
const MAX_CHUNK = 500;
const MAX_CONTACT_IDS = 10_000;
const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

export type PrepareRecipientsInput = { contactIds?: unknown };
export type PrepareRecipientsResult =
  | {
      ok: true;
      campaignId: string;
      /** Contacts judged in this run (new candidates only). */
      considered: number;
      added: number;
      alreadyPrepared: number;
      /** Existing PENDING recipients found no longer eligible and marked SKIPPED. */
      skippedNow: number;
      /** Candidates left out, counted by the fixed vocabulary only (no ids, addresses or suppression details). */
      excluded: Record<MarketingSkipReason, number>;
      recipientCount: number;
    }
  | { ok: false; reason: "invalid_input" | "not_found" | "not_editable"; message: string };

class NotDraft extends Error {}

const emptyExcluded = () => Object.fromEntries(MARKETING_SKIP_REASONS.map((r) => [r, 0])) as Record<MarketingSkipReason, number>;
const elig = (tx: Prisma.TransactionClient) => tx as unknown as EligibilityDb; // the gate only reads emailContact, marketingConsent and emailSuppression
const chunksOf = <T,>(items: T[], n: number): T[][] => Array.from({ length: Math.ceil(items.length / n) }, (_, i) => items.slice(i * n, (i + 1) * n));

/** Re-checks eligibility; anything that is not a clear "eligible with a consent id" (including a thrown error) is "unverifiable". */
async function judge(tx: Prisma.TransactionClient, email: string, now: Date): Promise<{ ok: true; consentId: string } | { ok: false; reason: MarketingSkipReason }> {
  try {
    const verdict = await getMarketingEligibility(email, { db: elig(tx), now });
    if (verdict.eligible && verdict.consentId) return { ok: true, consentId: verdict.consentId };
    return { ok: false, reason: verdict.eligible ? "unverifiable" : verdict.reason };
  } catch {
    return { ok: false, reason: "unverifiable" };
  }
}

/** Locks the campaign row for this transaction and proves it is still a DRAFT, so scheduling/cancelling cannot interleave with a chunk. */
async function guardDraft(tx: Prisma.TransactionClient, campaignId: string, now: Date) {
  const res = await tx.emailCampaign.updateMany({ where: { id: campaignId, status: "DRAFT" }, data: { updatedAt: now } });
  if (res.count === 0) throw new NotDraft();
}

function parseContactIds(raw: unknown): { ok: true; ids: string[] | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, ids: null };
  if (!Array.isArray(raw) || raw.length > MAX_CONTACT_IDS || !raw.every(isRecordId)) return { ok: false, message: `contactIds must be a list of at most ${MAX_CONTACT_IDS} valid contact ids.` };
  return { ok: true, ids: [...new Set(raw as string[])] };
}

/**
 * Prepares (or refreshes) the audience of a DRAFT campaign. With `contactIds` only those contacts are considered; without it, every active
 * contact is. Either way only the eligibility check decides who is added. Safe to repeat and to run concurrently.
 */
export async function prepareCampaignRecipients(
  campaignId: unknown,
  input: PrepareRecipientsInput = {},
  opts: { db?: Db; now?: Date; chunkSize?: number } = {},
): Promise<PrepareRecipientsResult> {
  if (!isRecordId(campaignId)) return { ok: false, reason: "not_found", message: "Campaign not found." };
  const parsed = parseContactIds(input?.contactIds);
  if (!parsed.ok) return { ok: false, reason: "invalid_input", message: parsed.message };
  const chunk = Number.isInteger(opts.chunkSize) && (opts.chunkSize as number) >= 1 ? Math.min(opts.chunkSize as number, MAX_CHUNK) : DEFAULT_CHUNK;
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();

  const campaign = await db.emailCampaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true } });
  if (!campaign) return { ok: false, reason: "not_found", message: "Campaign not found." };
  if (!isCampaignEditable(campaign.status)) return { ok: false, reason: "not_editable", message: "The audience can only be prepared while the campaign is a draft." };

  const stats = { considered: 0, added: 0, alreadyPrepared: 0, skippedNow: 0, excluded: emptyExcluded() };
  const tx$ = <T,>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async (tx: Prisma.TransactionClient) => { await guardDraft(tx, campaignId, now); return fn(tx); }, TX_OPTIONS);

  try {
    // Pass A: re-check the recipients already in the snapshot that are still PENDING.
    let after = "";
    for (;;) {
      const last = await tx$(async (tx) => {
        const rows = await tx.emailCampaignRecipient.findMany({ where: { campaignId, status: "PENDING", id: { gt: after } }, orderBy: { id: "asc" }, take: chunk, select: { id: true, contactId: true } });
        if (!rows.length) return null;
        const contacts = await tx.emailContact.findMany({ where: { id: { in: rows.map((r) => r.contactId) } }, select: { id: true, email: true } });
        const emailById = new Map(contacts.map((c) => [c.id, c.email]));
        for (const row of rows) {
          const email = emailById.get(row.contactId);
          const verdict = email ? await judge(tx, email, now) : ({ ok: false, reason: "no_contact" } as const);
          if (!verdict.ok) {
            const res = await tx.emailCampaignRecipient.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "SKIPPED", skipReason: verdict.reason } });
            stats.skippedNow += res.count;
          }
        }
        return rows[rows.length - 1].id;
      });
      if (last === null) break;
      after = last;
    }

    // Pass B: judge new candidates and add the eligible ones.
    const addChunk = async (tx: Prisma.TransactionClient, contacts: { id: string; email: string }[]) => {
      const existing = await tx.emailCampaignRecipient.findMany({ where: { campaignId, contactId: { in: contacts.map((c) => c.id) } }, select: { contactId: true } });
      const have = new Set(existing.map((r) => r.contactId));
      const toCreate: { campaignId: string; contactId: string; consentId: string; status: "PENDING" }[] = [];
      for (const c of contacts) {
        if (have.has(c.id)) { stats.alreadyPrepared++; continue; }
        stats.considered++;
        const verdict = await judge(tx, c.email, now);
        if (verdict.ok) toCreate.push({ campaignId, contactId: c.id, consentId: verdict.consentId, status: "PENDING" });
        else stats.excluded[verdict.reason]++;
      }
      if (!toCreate.length) return;
      const res = await tx.emailCampaignRecipient.createMany({ data: toCreate, skipDuplicates: true });
      stats.added += res.count;
      stats.alreadyPrepared += toCreate.length - res.count; // a concurrent run inserted it first
    };

    if (parsed.ids) {
      for (const ids of chunksOf(parsed.ids, chunk)) {
        await tx$(async (tx) => {
          const found = await tx.emailContact.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
          stats.excluded.no_contact += ids.length - found.length;
          stats.considered += ids.length - found.length;
          await addChunk(tx, found);
        });
      }
    } else {
      let cursor = "";
      for (;;) {
        const next = await tx$(async (tx) => {
          const contacts = await tx.emailContact.findMany({ where: { isActive: true, id: { gt: cursor } }, orderBy: { id: "asc" }, take: chunk, select: { id: true, email: true } });
          if (!contacts.length) return null;
          await addChunk(tx, contacts);
          return contacts[contacts.length - 1].id;
        });
        if (next === null) break;
        cursor = next;
      }
    }

    const recipientCount = await tx$(async (tx) => {
      const total = await tx.emailCampaignRecipient.count({ where: { campaignId } });
      const skipped = await tx.emailCampaignRecipient.count({ where: { campaignId, status: "SKIPPED" } });
      await tx.emailCampaign.updateMany({ where: { id: campaignId, status: "DRAFT" }, data: { recipientCount: total, skippedCount: skipped } });
      return total;
    });
    return { ok: true, campaignId, ...stats, recipientCount };
  } catch (e) {
    if (e instanceof NotDraft) return { ok: false, reason: "not_editable", message: "The campaign is no longer a draft; its audience was not changed further." };
    throw e; // a failed chunk was rolled back; earlier chunks are kept and a re-run finishes the job
  }
}
