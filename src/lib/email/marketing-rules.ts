/**
 * E-mail marketing policy rules (Prompt 08). PURE: no database, no network, no secrets. The contact, consent, suppression and unsubscribe
 * services share these so every one of them validates input and decides "may a consent lift a suppression?" the same way. Built on the
 * normalisation and eligibility rule in ./marketing. Server-side only like the rest of src/lib/email.
 */

export const CONTACT_SOURCES = ["MANUAL", "CSV_IMPORT", "CUSTOMER"] as const;
export const CONSENT_SOURCES = ["ADMIN_RECORDED", "CSV_IMPORT", "CUSTOMER_ACCOUNT", "CHECKOUT_MARKETING", "SIGNUP_FORM"] as const;
export const UNSUBSCRIBE_SOURCES = ["LINK", "ADMIN", "CUSTOMER_ACCOUNT", "BOUNCE", "COMPLAINT"] as const;
export const SUPPRESSION_REASONS = ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "ADMIN"] as const;

export type ContactSource = (typeof CONTACT_SOURCES)[number];
export type ConsentSource = (typeof CONSENT_SOURCES)[number];
export type UnsubscribeSource = (typeof UNSUBSCRIBE_SOURCES)[number];
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

const oneOf = <T extends string>(list: readonly T[]) => (value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
export const isContactSource = oneOf(CONTACT_SOURCES);
/** Only these count as explicit marketing consent. Anything else (for example "saving checkout progress") is not in the list and is refused. */
export const isConsentSource = oneOf(CONSENT_SOURCES);
export const isUnsubscribeSource = oneOf(UNSUBSCRIBE_SOURCES);
export const isSuppressionReason = oneOf(SUPPRESSION_REASONS);

export const MAX_EVIDENCE_LENGTH = 500; // the database CHECK on MarketingConsent.evidence and EmailSuppression.note
export const MAX_NAME_LENGTH = 200; // the database CHECK on EmailContact.name

/** undefined/null/blank -> null (nothing to store); a non-string or a too-long text -> invalid (never silently cut). */
export function cleanOptionalText(raw: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const noControls = Array.from(raw, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("");
  const value = noControls.replace(/\s+/g, " ").trim();
  if (value.length > max) return { ok: false };
  return { ok: true, value: value || null };
}

/** Higher outranks lower. A stronger active suppression is never downgraded by a weaker one. */
const RANK: Record<SuppressionReason, number> = { UNSUBSCRIBED: 1, ADMIN: 2, BOUNCED: 3, COMPLAINED: 4 };
export const outranksSuppression = (next: SuppressionReason, current: SuppressionReason) => RANK[next] > RANK[current];

/** The source stamped on the consent that a suppression closes. */
export function unsubscribeSourceForSuppression(reason: SuppressionReason, requested?: UnsubscribeSource): UnsubscribeSource {
  if (reason === "BOUNCED") return "BOUNCE";
  if (reason === "COMPLAINED") return "COMPLAINT";
  if (reason === "ADMIN") return "ADMIN";
  return requested && requested !== "BOUNCE" && requested !== "COMPLAINT" ? requested : "LINK";
}

/**
 * May a NEW explicit consent end an UNSUBSCRIBED suppression? Only a deliberate act by the person or an admin who can show it:
 *  - a bulk CSV attestation never does (a re-imported list must not quietly resubscribe people who opted out);
 *  - an admin-recorded consent needs its evidence written down;
 *  - the customer's own account, the dedicated checkout marketing tick-box and a public sign-up form do.
 * BOUNCED, COMPLAINED and ADMIN suppressions are never lifted by a consent (that policy belongs to a later prompt).
 */
export function consentMayLiftUnsubscribe(consent: { source: ConsentSource; evidence: string | null }): boolean {
  if (consent.source === "CSV_IMPORT") return false;
  if (consent.source === "ADMIN_RECORDED") return Boolean(consent.evidence);
  return true;
}

/** A consent counts only while open, from a known explicit source, and granted at a real moment that is not in the future. */
export function isConsentCurrentlyValid(consent: { source: unknown; grantedAt: unknown; unsubscribedAt: unknown }, now: Date): boolean {
  if (consent.unsubscribedAt != null) return false;
  if (!isConsentSource(consent.source)) return false;
  const granted = consent.grantedAt;
  return granted instanceof Date && !Number.isNaN(granted.getTime()) && granted.getTime() <= now.getTime();
}
