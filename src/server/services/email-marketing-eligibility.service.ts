import "server-only";
import { prisma } from "@/lib/db/prisma";
import { evaluateMarketingEligibility, normalizeContactEmail, type MarketingEligibility } from "@/lib/email/marketing";
import { isConsentCurrentlyValid } from "@/lib/email/marketing-rules";
import { checkEmailSuppression } from "@/server/services/email-suppression.service";

type Db = typeof prisma;

/**
 * Read-only gate for the future marketing/recovery senders: may this address receive marketing or recovery e-mail RIGHT NOW? Eligible only with an
 * active contact, a VALID explicit marketing consent (open, from a known marketing source, granted at or before `now`) and NO active suppression
 * (unsubscribed, bounced, complained or manual). It writes nothing, never sends and never enqueues. Checkout progress-saving consent
 * (IncompleteCheckout.consentAt) is not consulted: it is not marketing consent.
 *
 * FAILS CLOSED: when any part cannot be verified (a failing query, an unreadable row) the answer is not eligible, reason "unverifiable".
 */
export async function getMarketingEligibility(rawEmail: unknown, opts: { db?: Db; now?: Date } = {}): Promise<MarketingEligibility & { consentId?: string }> {
  const normalized = normalizeContactEmail(rawEmail);
  if (!normalized.ok) return { eligible: false, reason: "invalid_email" };
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const email = normalized.email;

  try {
    const suppression = await checkEmailSuppression(email, { db });
    if (suppression.suppressed && suppression.reason === "unverifiable") return { eligible: false, reason: "unverifiable" };

    const contact = await db.emailContact.findUnique({ where: { email }, select: { id: true, isActive: true } });
    if (contact && typeof contact.isActive !== "boolean") return { eligible: false, reason: "unverifiable" };
    const consent = contact
      ? await db.marketingConsent.findFirst({
          where: { contactId: contact.id, unsubscribedAt: null },
          orderBy: { grantedAt: "desc" },
          select: { id: true, source: true, grantedAt: true, unsubscribedAt: true },
        })
      : null;
    const validConsent = consent && isConsentCurrentlyValid(consent, now) ? consent : null;

    const verdict = evaluateMarketingEligibility({ contact, hasOpenConsent: Boolean(validConsent), suppressed: suppression.suppressed });
    return verdict.eligible && validConsent ? { ...verdict, consentId: validConsent.id } : verdict;
  } catch {
    return { eligible: false, reason: "unverifiable" };
  }
}
