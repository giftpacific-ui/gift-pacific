/**
 * E-mail marketing rules (Prompt 07). PURE: no database, no network, no secrets. Shared by the future contact, consent, campaign and recovery
 * code so they all normalise, hash, de-duplicate and decide eligibility the same way. The tables these rules protect are in prisma/schema.prisma
 * ("Email marketing database architecture"); the database CHECK constraints in migration 20261201000000 mirror the normalisation rule here.
 * Server-side only like the rest of src/lib/email (a test enforces that nothing under features/components imports it).
 */
import { createHash, randomBytes } from "node:crypto";
import { validateRecipientEmail } from "@/lib/email/config";

// ------------------------------------------------------------------------------------------------------------------------------ e-mail address

export type NormalizedEmail = { ok: true; email: string } | { ok: false; message: string };

/**
 * The ONE normal form of an address for contacts and suppressions: Unicode NFKC, trimmed, lower-case. `A@X.com` and ` a@x.com ` are the same
 * address. Deliberately NOT done: removing "+tag" or Gmail dots (that would merge different mailboxes at other providers). Validity is the same rule
 * the SMTP layer applies (one address, no control characters, no display name), so a stored contact can always be queued.
 */
export function normalizeContactEmail(raw: unknown): NormalizedEmail {
  if (typeof raw !== "string") return { ok: false, message: "Enter one valid e-mail address (for example you@example.com)." };
  const checked = validateRecipientEmail(raw.normalize("NFKC").trim().toLowerCase());
  if (!checked.ok) return { ok: false, message: checked.message };
  return { ok: true, email: checked.email };
}

// ------------------------------------------------------------------------------------------------------------------------- unsubscribe tokens

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url, no padding
const HASH = /^[0-9a-f]{64}$/;

/** SHA-256 (hex) of a token. null for anything that is not a well-formed token, so garbage never reaches a lookup. */
export function hashUnsubscribeToken(token: unknown): string | null {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A new unsubscribe token: 256 random bits. The `token` goes into the e-mail link and is shown to nobody else; ONLY the `hash` is stored
 * (EmailContact.unsubscribeTokenHash). A high-entropy random token needs no salt or slow hash; a database leak does not reveal usable links.
 */
export function generateUnsubscribeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashUnsubscribeToken(token)! };
}

export const isUnsubscribeTokenHash = (value: unknown): value is string => typeof value === "string" && HASH.test(value);

// ------------------------------------------------------------------------------------------------------------------------- recovery event keys

const ID = /^[A-Za-z0-9_-]{1,64}$/; // a cuid; no ":" so the parts of a key can never run into each other

/** INCOMPLETE_CHECKOUT recovery event: one per IncompleteCheckout row. null for an unusable id. */
export function incompleteCheckoutEventKey(incompleteCheckoutId: string): string | null {
  return typeof incompleteCheckoutId === "string" && ID.test(incompleteCheckoutId) ? `ic:${incompleteCheckoutId}` : null;
}

/**
 * ABANDONED_CART recovery event: a cart plus the time of its last activity (the same "last activity" abandoned-cart.service computes). The same
 * abandonment always gives the same key (so it is reminded once per step); a cart that is used again and abandoned later is a NEW event.
 */
export function abandonedCartEventKey(cartId: string, lastActivity: Date): string | null {
  if (typeof cartId !== "string" || !ID.test(cartId)) return null;
  if (!(lastActivity instanceof Date) || Number.isNaN(lastActivity.getTime())) return null;
  return `ac:${cartId}:${lastActivity.getTime()}`;
}

export const RECOVERY_KIND_FOR_PREFIX = { ic: "INCOMPLETE_CHECKOUT", ac: "ABANDONED_CART" } as const;

// ------------------------------------------------------------------------------------------------------------------------------- eligibility

/** Why a marketing or recovery e-mail must NOT go to an address. A fixed vocabulary: safe to store as RecoveryEmail/EmailCampaignRecipient.skipReason. */
export const MARKETING_SKIP_REASONS = ["invalid_email", "no_contact", "suppressed", "inactive", "no_consent", "unverifiable"] as const;
export type MarketingSkipReason = (typeof MARKETING_SKIP_REASONS)[number];
export type MarketingEligibility = { eligible: true } | { eligible: false; reason: MarketingSkipReason };

export type MarketingFacts = {
  /** The EmailContact for the address, or null when there is none. */
  contact: { isActive: boolean } | null;
  /** A MarketingConsent row with unsubscribedAt = null exists for the contact. Checkout progress-saving consent never counts. */
  hasOpenConsent: boolean;
  /** An EmailSuppression row for the address with liftedAt = null exists. */
  suppressed: boolean;
};

/**
 * THE rule. An address may receive marketing/recovery e-mail only if it has an ACTIVE contact, an OPEN marketing consent and NO active suppression.
 * Checked in this order; the first failure is the reason. A suppression wins over everything (including a fresh consent).
 */
export function evaluateMarketingEligibility(facts: MarketingFacts): MarketingEligibility {
  if (!facts.contact) return { eligible: false, reason: facts.suppressed ? "suppressed" : "no_contact" };
  if (facts.suppressed) return { eligible: false, reason: "suppressed" };
  if (!facts.contact.isActive) return { eligible: false, reason: "inactive" };
  if (!facts.hasOpenConsent) return { eligible: false, reason: "no_consent" };
  return { eligible: true };
}
