import "server-only";
import { prisma } from "@/lib/db/prisma";
import { normalizeContactEmail } from "@/lib/email/marketing";
import { cleanOptionalText, isContactSource, MAX_NAME_LENGTH, type ContactSource } from "@/lib/email/marketing-rules";

type Db = typeof prisma;

const SELECT = { id: true, email: true, name: true, source: true, userId: true, isActive: true } as const;
export type EmailContactView = { id: string; email: string; name: string | null; source: ContactSource; userId: string | null; isActive: boolean };
/** none: no user given; linked: the contact now points at the user; kept_existing: it already has a valid user, left alone; not_linked: the user is unusable. */
export type UserLinkOutcome = "none" | "linked" | "kept_existing" | "not_linked";
export type UpsertEmailContactResult =
  | { ok: true; created: boolean; contact: EmailContactView; userLink: UserLinkOutcome }
  | { ok: false; reason: "invalid_email" | "invalid_source" | "invalid_name" | "user_required" };

export type UpsertEmailContactInput = {
  email: unknown;
  source: unknown;
  /** undefined or blank = leave the stored name alone. */
  name?: unknown;
  userId?: string | null;
  createdById?: string | null;
};

/** A user may be linked only if it exists, is active, and its own account address is this contact's address (same normal form). */
async function userMayBeLinked(db: Db, userId: string, email: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, isActive: true } });
  if (!user || !user.isActive) return false;
  const own = normalizeContactEmail(user.email);
  return own.ok && own.email === email;
}

/**
 * Creates the contact for an address, or updates the existing one. The address is normalised first, so "Jane@X.com" and " jane@x.com " are one
 * contact; a concurrent create that loses the unique-index race falls back to the update path. On an existing contact it only ever:
 *  - sets the name when a non-blank one is given;
 *  - links a user when the contact has none (or its recorded user no longer exists) and the user may be linked;
 * It NEVER changes the source (the original provenance stays), isActive, consent or suppression: re-adding an address (an import, a sign-up)
 * cannot undo an unsubscribe or reactivate a contact. A CUSTOMER contact needs a linkable user at creation.
 */
export async function upsertEmailContact(input: UpsertEmailContactInput, opts: { db?: Db } = {}): Promise<UpsertEmailContactResult> {
  const db = opts.db ?? prisma;
  const normalized = normalizeContactEmail(input.email);
  if (!normalized.ok) return { ok: false, reason: "invalid_email" };
  const source = input.source;
  if (!isContactSource(source)) return { ok: false, reason: "invalid_source" };
  const name = cleanOptionalText(input.name, MAX_NAME_LENGTH);
  if (!name.ok) return { ok: false, reason: "invalid_name" };
  const email = normalized.email;
  const wantsLink = typeof input.userId === "string" && input.userId.length > 0;
  const linkable = wantsLink ? await userMayBeLinked(db, input.userId as string, email) : false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await db.emailContact.findUnique({ where: { email }, select: SELECT });
    if (!existing) {
      if (source === "CUSTOMER" && !linkable) return { ok: false, reason: "user_required" };
      try {
        const created = await db.emailContact.create({
          data: { email, source, name: name.value, userId: linkable ? (input.userId as string) : null, createdById: input.createdById ?? null },
          select: SELECT,
        });
        return { ok: true, created: true, contact: created, userLink: !wantsLink ? "none" : linkable ? "linked" : "not_linked" };
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002" && attempt === 0) continue; // somebody created it first: update that one
        throw e;
      }
    }

    const data: { name?: string; userId?: string } = {};
    if (name.value !== null && name.value !== existing.name) data.name = name.value;
    let userLink: UserLinkOutcome = "none";
    if (wantsLink) {
      if (existing.userId === input.userId) userLink = "kept_existing";
      else {
        const currentStillExists = existing.userId ? Boolean(await db.user.findUnique({ where: { id: existing.userId }, select: { id: true } })) : false;
        if (currentStillExists) userLink = "kept_existing"; // never overwrite a valid relationship
        else if (linkable) { data.userId = input.userId as string; userLink = "linked"; }
        else userLink = "not_linked";
      }
    }
    const contact = Object.keys(data).length ? await db.emailContact.update({ where: { id: existing.id }, data, select: SELECT }) : existing;
    return { ok: true, created: false, contact, userLink };
  }
  throw new Error("upsertEmailContact: unreachable"); // the loop returns or throws on its last attempt
}

/** The contact for an address, or null (including for an unusable address). */
export async function findEmailContactByEmail(rawEmail: unknown, opts: { db?: Db } = {}): Promise<EmailContactView | null> {
  const normalized = normalizeContactEmail(rawEmail);
  if (!normalized.ok) return null;
  return (opts.db ?? prisma).emailContact.findUnique({ where: { email: normalized.email }, select: SELECT });
}

/** Contact status. Deactivating keeps every record; reactivating restores nothing else: consent and suppression decide eligibility on their own. */
export async function setEmailContactActive(contactId: string, isActive: boolean, opts: { db?: Db } = {}): Promise<{ ok: true } | { ok: false; reason: "no_contact" }> {
  const res = await (opts.db ?? prisma).emailContact.updateMany({ where: { id: contactId }, data: { isActive } });
  return res.count > 0 ? { ok: true } : { ok: false, reason: "no_contact" };
}
