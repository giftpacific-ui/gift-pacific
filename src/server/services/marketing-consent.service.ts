import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  cleanOptionalText, consentMayLiftUnsubscribe, isConsentSource, isUnsubscribeSource, MAX_EVIDENCE_LENGTH, type UnsubscribeSource,
} from "@/lib/email/marketing-rules";

type Db = typeof prisma;
type ConsentClient = Pick<Prisma.TransactionClient, "marketingConsent">;

export type RecordMarketingConsentInput = { source: unknown; evidence?: unknown; recordedById?: string | null };
/** suppression: none (nothing blocked it), lifted (this consent ended an UNSUBSCRIBED suppression), still_active (an earlier open consent exists but a suppression still blocks). */
export type RecordMarketingConsentResult =
  | { ok: true; consentId: string; created: boolean; suppression: "none" | "lifted" | "still_active" }
  | { ok: false; reason: "invalid_source" | "invalid_evidence" | "no_contact" | "inactive" | "suppressed" };

/**
 * Records ONE explicit marketing opt-in for a contact: source, timestamp and optional evidence. History is append-only: every opt-in period is its
 * own row, an open one is never rewritten, and calling this while a consent is already open changes nothing (created:false). Only the sources in
 * the MarketingConsentSource list count; "saving checkout progress" (IncompleteCheckout.consentAt) is not one of them and is never read here.
 *
 * A new consent is also the ONLY way back from an unsubscribe: if the address has an active UNSUBSCRIBED suppression, a consent that
 * `consentMayLiftUnsubscribe` accepts lifts it, in the same transaction (the suppression row stays, stamped liftedAt). Any other consent is
 * REFUSED ("suppressed") and writes nothing: a BOUNCED, COMPLAINED or ADMIN suppression, or an unsubscribe that a bulk import cannot lift, keeps
 * blocking, and no open consent is left behind to be mistaken for a fresh opt-in once the suppression is lifted some other way.
 * `neverLiftSuppression` (default false) is for callers that must NEVER end a suppression, whatever the consent source (the admin "Add contact" form): with it,
 * ANY active suppression found inside this same transaction refuses the consent ("suppressed"). The decision is therefore made on the very read that would
 * otherwise authorise the lift, so a suppression recorded concurrently (before that read) cannot be lifted, and one recorded after it simply wins over the
 * consent (suppression closes consent and blocks eligibility). Without the option the rules above are unchanged.
 * It never sends anything and never enqueues a job.
 */
export async function recordMarketingConsent(
  contactId: string,
  input: RecordMarketingConsentInput,
  opts: { db?: Db; now?: Date; neverLiftSuppression?: boolean } = {},
): Promise<RecordMarketingConsentResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const source = input.source;
  if (!isConsentSource(source)) return { ok: false, reason: "invalid_source" };
  const evidence = cleanOptionalText(input.evidence, MAX_EVIDENCE_LENGTH);
  if (!evidence.ok) return { ok: false, reason: "invalid_evidence" };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.$transaction(async (tx): Promise<RecordMarketingConsentResult> => {
        const contact = await tx.emailContact.findUnique({ where: { id: contactId }, select: { id: true, email: true, isActive: true } });
        if (!contact) return { ok: false, reason: "no_contact" };
        if (!contact.isActive) return { ok: false, reason: "inactive" };
        const suppression = await tx.emailSuppression.findFirst({ where: { email: contact.email, liftedAt: null }, select: { id: true, reason: true } });

        const mayLift = !opts.neverLiftSuppression && suppression?.reason === "UNSUBSCRIBED" && consentMayLiftUnsubscribe({ source, evidence: evidence.value });
        if (suppression && !mayLift) return { ok: false, reason: "suppressed" };

        const open = await tx.marketingConsent.findFirst({ where: { contactId, unsubscribedAt: null }, select: { id: true } });
        if (open) return { ok: true, consentId: open.id, created: false, suppression: suppression ? "still_active" : "none" };

        const consent = await tx.marketingConsent.create({
          data: { contactId, source, grantedAt: now, evidence: evidence.value, recordedById: input.recordedById ?? null },
          select: { id: true },
        });
        if (!suppression) return { ok: true, consentId: consent.id, created: true, suppression: "none" };
        await tx.emailSuppression.update({ where: { id: suppression.id }, data: { liftedAt: now, liftedById: input.recordedById ?? null } });
        return { ok: true, consentId: consent.id, created: true, suppression: "lifted" };
      });
    } catch (e) {
      // Two opt-ins raced and the partial unique index (one open consent per contact) refused the second: run again, which finds the open one.
      if ((e as { code?: string })?.code === "P2002" && attempt === 0) continue;
      throw e;
    }
  }
  throw new Error("recordMarketingConsent: unreachable");
}

/**
 * Ends the contact's open consent by stamping it (unsubscribedAt + unsubscribeSource); the row is kept as history. Returns null when no consent is
 * open. Used by withdrawal, unsubscribe and suppression. `unsubscribedAt` is never earlier than `grantedAt` (the database CHECK).
 */
export async function closeOpenConsent(client: ConsentClient, contactId: string, source: UnsubscribeSource, now: Date): Promise<{ consentId: string } | null> {
  const open = await client.marketingConsent.findFirst({ where: { contactId, unsubscribedAt: null }, select: { id: true, grantedAt: true } });
  if (!open) return null;
  const at = now.getTime() < open.grantedAt.getTime() ? open.grantedAt : now;
  const res = await client.marketingConsent.updateMany({ where: { id: open.id, unsubscribedAt: null }, data: { unsubscribedAt: at, unsubscribeSource: source } });
  return res.count > 0 ? { consentId: open.id } : null;
}

/**
 * Consent WITHDRAWAL: the contact no longer consents, from `source`. It ends eligibility (no open consent) but does not by itself suppress the
 * address; opting in again later is simply a new consent. Use the unsubscribe service when the address must also be suppressed. Idempotent.
 */
export async function withdrawMarketingConsent(
  contactId: string,
  source: unknown,
  opts: { db?: Db; now?: Date } = {},
): Promise<{ ok: true; withdrawn: boolean; consentId?: string } | { ok: false; reason: "invalid_source" }> {
  if (!isUnsubscribeSource(source)) return { ok: false, reason: "invalid_source" };
  const closed = await closeOpenConsent(opts.db ?? prisma, contactId, source, opts.now ?? new Date());
  return closed ? { ok: true, withdrawn: true, consentId: closed.consentId } : { ok: true, withdrawn: false };
}
