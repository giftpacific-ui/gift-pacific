import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeContactEmail } from "@/lib/email/marketing";
import {
  cleanOptionalText, isSuppressionReason, isUnsubscribeSource, MAX_EVIDENCE_LENGTH, outranksSuppression, unsubscribeSourceForSuppression,
  type SuppressionReason, type UnsubscribeSource,
} from "@/lib/email/marketing-rules";
import { closeOpenConsent } from "@/server/services/marketing-consent.service";

type Db = typeof prisma;
type SuppressionClient = Pick<Prisma.TransactionClient, "emailSuppression">;

export type SuppressionCheck = { suppressed: false } | { suppressed: true; reason: SuppressionReason | "unverifiable" };

/**
 * Is this address blocked from marketing/recovery e-mail RIGHT NOW? Reads the one EmailSuppression row for the normalised address; a row with
 * liftedAt = null blocks, whatever its reason (unsubscribed, bounced, complained, admin). FAILS CLOSED: an unusable address, a failing query or a
 * stored reason this code does not know all answer suppressed:true / "unverifiable", never "not suppressed". Writes nothing.
 */
export async function checkEmailSuppression(rawEmail: unknown, opts: { db?: SuppressionClient } = {}): Promise<SuppressionCheck> {
  const normalized = normalizeContactEmail(rawEmail);
  if (!normalized.ok) return { suppressed: true, reason: "unverifiable" };
  try {
    const row = await (opts.db ?? prisma).emailSuppression.findFirst({ where: { email: normalized.email, liftedAt: null }, select: { reason: true } });
    if (!row) return { suppressed: false };
    return { suppressed: true, reason: isSuppressionReason(row.reason) ? row.reason : "unverifiable" };
  } catch {
    return { suppressed: true, reason: "unverifiable" };
  }
}

export type SuppressEmailInput = {
  reason: unknown;
  note?: unknown;
  actorId?: string | null;
  /** Where an UNSUBSCRIBED suppression came from (LINK, ADMIN, CUSTOMER_ACCOUNT). BOUNCED/COMPLAINED/ADMIN set their own source. */
  unsubscribeSource?: unknown;
};
export type SuppressEmailResult =
  | { ok: true; action: "created" | "reactivated" | "upgraded" | "unchanged"; effectiveReason: SuppressionReason; consentClosed: boolean }
  | { ok: false; reason: "invalid_email" | "invalid_reason" | "invalid_note" | "invalid_source" };

/**
 * Puts an address under suppression (unsubscribed, bounced, complained or manually suppressed). Keyed by the normalised ADDRESS, so it works
 * for an address with no contact and survives contact changes. One row per address, handled safely:
 *  - none yet: created; a lifted one: reactivated with the new reason;
 *  - already active: the STRONGER reason wins (COMPLAINED > BOUNCED > ADMIN > UNSUBSCRIBED), a weaker one never downgrades it, and a repeat is a no-op;
 *  - the contact's open marketing consent (if any) is closed in the same transaction, stamped with the matching unsubscribe source.
 * Nothing is deleted, and nothing here can lift a suppression: that only happens through a new explicit consent (recordMarketingConsent).
 */
export async function suppressEmail(rawEmail: unknown, input: SuppressEmailInput, opts: { db?: Db; now?: Date } = {}): Promise<SuppressEmailResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const normalized = normalizeContactEmail(rawEmail);
  if (!normalized.ok) return { ok: false, reason: "invalid_email" };
  const reason = input.reason;
  if (!isSuppressionReason(reason)) return { ok: false, reason: "invalid_reason" };
  if (input.unsubscribeSource !== undefined && !isUnsubscribeSource(input.unsubscribeSource)) return { ok: false, reason: "invalid_source" };
  const note = cleanOptionalText(input.note, MAX_EVIDENCE_LENGTH);
  if (!note.ok) return { ok: false, reason: "invalid_note" };
  const email = normalized.email;
  const source: UnsubscribeSource = unsubscribeSourceForSuppression(reason, input.unsubscribeSource as UnsubscribeSource | undefined);
  const noteToStore = note.value ?? (reason === "UNSUBSCRIBED" ? `unsubscribed via ${source}` : null);
  const actor = input.actorId ?? null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.$transaction(async (tx): Promise<SuppressEmailResult> => {
        const contact = await tx.emailContact.findUnique({ where: { email }, select: { id: true } });
        const existing = await tx.emailSuppression.findUnique({ where: { email }, select: { id: true, reason: true, liftedAt: true, contactId: true, note: true } });
        let action: "created" | "reactivated" | "upgraded" | "unchanged";
        let effectiveReason: SuppressionReason = reason;
        if (!existing) {
          await tx.emailSuppression.create({ data: { email, reason, contactId: contact?.id ?? null, note: noteToStore, createdById: actor } });
          action = "created";
        } else if (existing.liftedAt) {
          await tx.emailSuppression.update({
            where: { id: existing.id },
            data: { reason, liftedAt: null, liftedById: null, contactId: existing.contactId ?? contact?.id ?? null, note: noteToStore ?? existing.note },
          });
          action = "reactivated";
        } else if (!isSuppressionReason(existing.reason) || outranksSuppression(reason, existing.reason)) {
          await tx.emailSuppression.update({ where: { id: existing.id }, data: { reason, contactId: existing.contactId ?? contact?.id ?? null, note: noteToStore ?? existing.note } });
          action = "upgraded";
        } else {
          effectiveReason = existing.reason;
          if (!existing.contactId && contact) await tx.emailSuppression.update({ where: { id: existing.id }, data: { contactId: contact.id } });
          action = "unchanged";
        }
        const closed = contact ? await closeOpenConsent(tx, contact.id, source, now) : null;
        return { ok: true, action, effectiveReason, consentClosed: Boolean(closed) };
      });
    } catch (e) {
      // Two suppressions of one address raced and the unique index refused the second: run again, which finds the first.
      if ((e as { code?: string })?.code === "P2002" && attempt === 0) continue;
      throw e;
    }
  }
  throw new Error("suppressEmail: unreachable");
}
