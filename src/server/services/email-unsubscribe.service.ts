import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { hashUnsubscribeToken } from "@/lib/email/marketing";
import {
  createUnsubscribeLink, deriveUnsubscribeToken, readUnsubscribeConfig, readUnsubscribeSecret, verifyUnsubscribeToken,
  type UnsubscribeConfig, type UnsubscribeUrl,
} from "@/lib/email/unsubscribe";
import { isUnsubscribeSource, type UnsubscribeSource } from "@/lib/email/marketing-rules";
import { suppressEmail, type SuppressEmailResult } from "@/server/services/email-suppression.service";

type Db = typeof prisma;
const SOURCES_FOR_UNSUBSCRIBE: readonly UnsubscribeSource[] = ["LINK", "ADMIN", "CUSTOMER_ACCOUNT"]; // BOUNCE/COMPLAINT are suppression reasons, not unsubscribes

export type UnsubscribeResult =
  | { ok: true; action: "created" | "reactivated" | "upgraded" | "unchanged"; consentClosed: boolean }
  | { ok: false; reason: "invalid_email" | "invalid_source" | "invalid_token" | "unknown_token" };

/**
 * Unsubscribe an address: closes its open marketing consent (stamped with `source`) and records an UNSUBSCRIBED suppression, in one transaction.
 * Works for an address with no contact. Idempotent, and it never weakens a stronger suppression (a complaint stays a complaint). The only way
 * back is a NEW explicit consent (recordMarketingConsent): re-adding or re-importing the address does not restore eligibility.
 */
export async function unsubscribeEmail(rawEmail: unknown, source: unknown, opts: { db?: Db; now?: Date; actorId?: string | null } = {}): Promise<UnsubscribeResult> {
  if (!isUnsubscribeSource(source) || !SOURCES_FOR_UNSUBSCRIBE.includes(source)) return { ok: false, reason: "invalid_source" };
  const res: SuppressEmailResult = await suppressEmail(rawEmail, { reason: "UNSUBSCRIBED", unsubscribeSource: source, actorId: opts.actorId }, opts);
  if (!res.ok) return { ok: false, reason: res.reason === "invalid_email" ? "invalid_email" : "invalid_source" };
  return { ok: true, action: res.action, consentClosed: res.consentClosed };
}

/**
 * P08 hash-lookup unsubscribe, kept unchanged for compatibility. Only the token's SHA-256 is looked up; a malformed or unknown token changes nothing.
 * It does NOT re-verify the token's signature. The public endpoint therefore uses `unsubscribeByStableToken` below, which does (Prompt 11).
 */
export async function unsubscribeByToken(token: unknown, opts: { db?: Db; now?: Date } = {}): Promise<UnsubscribeResult> {
  const hash = hashUnsubscribeToken(token);
  if (!hash) return { ok: false, reason: "invalid_token" };
  const contact = await (opts.db ?? prisma).emailContact.findUnique({ where: { unsubscribeTokenHash: hash }, select: { email: true } });
  if (!contact) return { ok: false, reason: "unknown_token" };
  return unsubscribeEmail(contact.email, "LINK", opts);
}

// ----------------------------------------------------------------------------------------------------------------------------------------
// Prompt 11: STABLE unsubscribe tokens. See src/lib/email/unsubscribe.ts for the design (HMAC of the contact id under EMAIL_UNSUBSCRIBE_SECRET;
// the database keeps only SHA-256(token) in EmailContact.unsubscribeTokenHash as the lookup index; the token itself is never stored).
// ----------------------------------------------------------------------------------------------------------------------------------------

type ContactClient = Pick<Prisma.TransactionClient, "emailContact">;
type Env = Record<string, string | undefined>;

export type EnsureLinkFailure = "invalid_contact" | "url_invalid" | "hash_conflict" | "no_contact";
export type EnsureLinkResult = { ok: true; url: UnsubscribeUrl } | { ok: false; reason: EnsureLinkFailure };

/**
 * Makes sure the contact's stable token hash is the one stored, and returns the contact's unsubscribe URL. IDEMPOTENT and safe to call from inside a
 * transaction: when the stored hash is already right nothing is written. Creating the link NEVER changes any other contact: if another contact already
 * holds this hash (data corruption: a SHA-256 collision is not possible) it refuses instead of writing, which would abort a PostgreSQL transaction.
 * `current` is the stored hash the caller already read (undefined/null = none). Writes nothing but this one column of this one contact.
 */
export async function ensureContactUnsubscribeLink(
  client: ContactClient,
  contact: { id: string; unsubscribeTokenHash?: string | null },
  config: Extract<UnsubscribeConfig, { ok: true }>,
  env: Env = process.env,
): Promise<EnsureLinkResult> {
  const link = createUnsubscribeLink(config, contact.id, env);
  if (!link.ok) return link;
  if ((contact.unsubscribeTokenHash ?? null) !== link.tokenHash) {
    const holder = await client.emailContact.findUnique({ where: { unsubscribeTokenHash: link.tokenHash }, select: { id: true } });
    if (holder && holder.id !== contact.id) return { ok: false, reason: "hash_conflict" };
    const res = await client.emailContact.updateMany({ where: { id: contact.id }, data: { unsubscribeTokenHash: link.tokenHash } });
    if (res.count !== 1) return { ok: false, reason: "no_contact" };
  }
  return { ok: true, url: link.url };
}

export type ContactLinkResult = EnsureLinkResult | { ok: false; reason: "config_unavailable" };

/** The unsubscribe URL of one contact by id (verifying and, if needed, repairing the stored hash). Fails closed when the secret or base URL is unusable. */
export async function getContactUnsubscribeLink(contactId: string, opts: { db?: ContactClient; env?: Env } = {}): Promise<ContactLinkResult> {
  const env = opts.env ?? process.env;
  const config = readUnsubscribeConfig(env);
  if (!config.ok) return { ok: false, reason: "config_unavailable" };
  const client = opts.db ?? prisma;
  const contact = await client.emailContact.findUnique({ where: { id: contactId }, select: { id: true, unsubscribeTokenHash: true } });
  if (!contact) return { ok: false, reason: "no_contact" };
  return ensureContactUnsubscribeLink(client, contact, config, env);
}

/**
 * (Re)issues the contact's token and stores its hash. The token is STABLE: calling this again returns the SAME token, and never invalidates a link that
 * was already sent. Returns the token once, for callers that need to show or test it; nothing else ever holds it. (Revoking every link is a deliberate
 * act: change EMAIL_UNSUBSCRIBE_SECRET.)
 */
export async function issueStableUnsubscribeToken(
  contactId: string,
  opts: { db?: ContactClient; env?: Env } = {},
): Promise<{ ok: true; token: string } | { ok: false; reason: "no_contact" | "secret_unavailable" | "hash_conflict" }> {
  const secret = readUnsubscribeSecret(opts.env ?? process.env);
  if (!secret.ok) return { ok: false, reason: "secret_unavailable" };
  const token = deriveUnsubscribeToken(secret.secret, contactId);
  const hash = token ? hashUnsubscribeToken(token) : null;
  if (!token || !hash) return { ok: false, reason: "no_contact" };
  const client = opts.db ?? prisma;
  const contact = await client.emailContact.findUnique({ where: { id: contactId }, select: { id: true, unsubscribeTokenHash: true } });
  if (!contact) return { ok: false, reason: "no_contact" };
  if (contact.unsubscribeTokenHash !== hash) {
    const holder = await client.emailContact.findUnique({ where: { unsubscribeTokenHash: hash }, select: { id: true } });
    if (holder && holder.id !== contactId) return { ok: false, reason: "hash_conflict" };
    await client.emailContact.updateMany({ where: { id: contactId }, data: { unsubscribeTokenHash: hash } });
  }
  return { ok: true, token };
}

/**
 * @deprecated since Prompt 11. It used to replace the token with a new random one, which silently killed every link already e-mailed. It now means
 * exactly `issueStableUnsubscribeToken` (same token every time). Kept so an old call site cannot reintroduce link-breaking rotation.
 */
export const rotateUnsubscribeToken = issueStableUnsubscribeToken;

export type ResolvedToken =
  | { ok: true; contactId: string; email: string }
  | { ok: false; reason: "invalid_token" | "unknown_token" | "secret_unavailable" };

/**
 * READ-ONLY: which contact does this token belong to? Used by GET (validate, change nothing) and by unsubscribeByStableToken. The result carries the
 * address for internal use only: callers must never put it in a response or a log.
 *   1. a malformed token is refused before anything else happens (no query);
 *   2. the secret must be usable (fail closed: without it nothing can be verified);
 *   3. the contact is found by SHA-256(token): the token itself is never sent to the database;
 *   4. the token is recomputed for THAT contact and compared in constant time, so a stored hash that does not belong to this contact (a legacy random
 *      token, corruption, a changed secret, a forged value) is rejected: one contact's token can never act on another contact.
 */
export async function resolveUnsubscribeToken(token: unknown, opts: { db?: ContactClient; env?: Env } = {}): Promise<ResolvedToken> {
  const hash = hashUnsubscribeToken(token);
  if (!hash) return { ok: false, reason: "invalid_token" };
  const secret = readUnsubscribeSecret(opts.env ?? process.env);
  if (!secret.ok) return { ok: false, reason: "secret_unavailable" };
  const contact = await (opts.db ?? prisma).emailContact.findUnique({ where: { unsubscribeTokenHash: hash }, select: { id: true, email: true } });
  if (!contact) return { ok: false, reason: "unknown_token" };
  if (!verifyUnsubscribeToken(secret.secret, contact.id, token)) return { ok: false, reason: "unknown_token" };
  return { ok: true, contactId: contact.id, email: contact.email };
}

export type StableUnsubscribeResult = UnsubscribeResult | { ok: false; reason: "secret_unavailable" };

/**
 * Unsubscribe through the link in an e-mail (the public route's POST). The token is verified (resolveUnsubscribeToken), then the contact is
 * unsubscribed through the SAME P08 path as every other source (`unsubscribeEmail`, source LINK): the open consent is closed and an UNSUBSCRIBED
 * suppression is created or reactivated, in one transaction; a stronger BOUNCED / COMPLAINED / ADMIN suppression is never weakened; repeating it
 * changes nothing. Only the contact that owns the token is affected.
 */
export async function unsubscribeByStableToken(token: unknown, opts: { db?: Db; env?: Env; now?: Date } = {}): Promise<StableUnsubscribeResult> {
  const resolved = await resolveUnsubscribeToken(token, { db: opts.db, env: opts.env });
  if (!resolved.ok) return resolved;
  return unsubscribeEmail(resolved.email, "LINK", { db: opts.db, now: opts.now });
}
