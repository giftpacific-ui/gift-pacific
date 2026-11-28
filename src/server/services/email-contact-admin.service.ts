import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { logServerError } from "@/lib/logger";
import { isRecordId } from "@/lib/email/template-rules";
import { normalizeContactEmail } from "@/lib/email/marketing";
import { cleanOptionalText, MAX_EVIDENCE_LENGTH, MAX_NAME_LENGTH, type SuppressionReason } from "@/lib/email/marketing-rules";
import {
  checkConsentEvidence, parseContactFilter, parseContactPage, parseContactSearch, parseCsv, planCsv, type CsvRowPlan,
} from "@/lib/email/contact-admin-rules";
import {
  CONTACTS_PAGE_SIZE, CSV_ISSUE_LIMIT, CSV_PREVIEW_ROWS,
  type ConsentStatus, type ContactDetail, type ContactFilter, type ContactListResult, type ContactListRow, type ContactStats, type CreateContactOutcome,
  type CsvImportSummary, type CsvPreview, type CsvRowPreview,
} from "@/lib/email-contacts";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";
import { setEmailContactActive, upsertEmailContact } from "@/server/services/email-contact.service";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { checkEmailSuppression } from "@/server/services/email-suppression.service";
import { recordMarketingConsent, withdrawMarketingConsent } from "@/server/services/marketing-consent.service";

type Db = typeof prisma;
type Opts = { db?: Db; now?: Date };

/**
 * Admin side of subscriber & contact management (P12-UI-01). A THIN layer over the existing P07/P08 services: contacts are created with
 * upsertEmailContact, consent is recorded ONLY with recordMarketingConsent, "may this address be mailed?" is ONLY ever answered by
 * getMarketingEligibility, and nothing here can lift a suppression, rewrite consent history, send mail or enqueue a job.
 *
 * Every operation re-checks that the actor is an ACTIVE ADMIN inside the service (not only in the server action), before any lookup or write.
 * The list FILTERS and the stat counts narrow the table with plain record queries (consent open / suppression active / flags); that narrowing never
 * decides eligibility: each row on screen is judged by getMarketingEligibility, and so is the eligible-subscriber count (up to a bounded sample).
 */

const ELIGIBILITY_CHECK_CAP = 500; // contacts individually verified for the "eligible" figure on the stat card
const SUPPRESSION_LOOKUP_CAP = 10_000; // suppressed addresses fetched to narrow a filter (the contact relation covers the rest)
const IMPORT_BATCH = 50;
const IMPORT_DEADLINE_MS = 25_000;
const LOOKUP_CHUNK = 200;
const MAX_BULK_IDS = 100;
const OTHER_SUPPRESSIONS: SuppressionReason[] = ["BOUNCED", "COMPLAINED", "ADMIN"];

const chunksOf = <T,>(items: T[], n: number): T[][] => Array.from({ length: Math.ceil(items.length / n) }, (_, i) => items.slice(i * n, (i + 1) * n));

// -------------------------------------------------------------------------------------------------------------------------- list narrowing

async function suppressedEmails(db: Db, reasons?: SuppressionReason[]): Promise<string[]> {
  const rows = await db.emailSuppression.findMany({
    where: { liftedAt: null, ...(reasons ? { reason: { in: reasons } } : {}) },
    select: { email: true },
    take: SUPPRESSION_LOOKUP_CAP,
  });
  return rows.map((r) => r.email);
}

/** A contact whose address has an active suppression (of these reasons, or any). The suppression is keyed by ADDRESS, so it is matched by address as well as by contact. */
async function hasSuppression(db: Db, reasons?: SuppressionReason[]): Promise<Prisma.EmailContactWhereInput> {
  const emails = await suppressedEmails(db, reasons);
  return { OR: [{ suppressions: { some: { liftedAt: null, ...(reasons ? { reason: { in: reasons } } : {}) } } }, { email: { in: emails } }] };
}

const hasOpenConsent: Prisma.EmailContactWhereInput = { consents: { some: { unsubscribedAt: null } } };

async function filterWhere(db: Db, filter: ContactFilter): Promise<Prisma.EmailContactWhereInput> {
  switch (filter) {
    case "eligible": // CANDIDATES only: the service verdict is applied to every row shown and to the stat count
      return { AND: [{ isActive: true }, hasOpenConsent, { NOT: [await hasSuppression(db)] }] };
    case "no_consent":
      return { AND: [{ NOT: [hasOpenConsent] }, { NOT: [await hasSuppression(db)] }] };
    case "unsubscribed": return hasSuppression(db, ["UNSUBSCRIBED"]);
    case "suppressed": return hasSuppression(db, OTHER_SUPPRESSIONS);
    case "inactive": return { isActive: false };
    case "manual": return { source: "MANUAL" };
    case "csv": return { source: "CSV_IMPORT" };
    case "customer": return { source: "CUSTOMER" };
    default: return {};
  }
}

async function buildWhere(db: Db, filter: ContactFilter, q: string): Promise<Prisma.EmailContactWhereInput> {
  const base = await filterWhere(db, filter);
  if (!q) return base;
  return { AND: [base, { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] }] };
}

// -------------------------------------------------------------------------------------------------------------------------------- stats

export async function adminGetEmailContactStats(actorId: unknown, opts: Opts & { eligibilityCap?: number } = {}): Promise<ContactStats> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  const cap = Number.isInteger(opts.eligibilityCap) && (opts.eligibilityCap as number) >= 1 ? (opts.eligibilityCap as number) : ELIGIBILITY_CHECK_CAP;

  const [eligibleWhere, unsubWhere, suppressedWhere] = await Promise.all([filterWhere(db, "eligible"), filterWhere(db, "unsubscribed"), filterWhere(db, "suppressed")]);
  const [total, inactive, unsubscribed, suppressed, candidates] = await Promise.all([
    db.emailContact.count(), db.emailContact.count({ where: { isActive: false } }),
    db.emailContact.count({ where: unsubWhere }), db.emailContact.count({ where: suppressedWhere }), db.emailContact.count({ where: eligibleWhere }),
  ]);

  // The eligible figure: candidates (active, open consent, no suppression record) that the ELIGIBILITY SERVICE confirms. Checked one by one, up to a bound.
  const sample = await db.emailContact.findMany({ where: eligibleWhere, orderBy: { id: "asc" }, take: cap, select: { email: true } });
  let rejected = 0;
  for (const c of sample) {
    const verdict = await getMarketingEligibility(c.email, { db, now });
    if (!verdict.eligible) rejected++;
  }
  return { total, eligible: Math.max(0, candidates - rejected), eligibleChecked: candidates <= cap, unsubscribed, suppressed, inactive };
}

// --------------------------------------------------------------------------------------------------------------------------------- list

type ContactCore = { id: string; email: string; name: string | null; source: string; isActive: boolean; createdAt: Date; userId: string | null };

function consentStatusOf(opts: { hasOpen: boolean; hasClosed: boolean; suppression: string | null }): ConsentStatus {
  if (opts.hasOpen) return "given";
  if (opts.suppression === "UNSUBSCRIBED") return "unsubscribed";
  return opts.hasClosed ? "withdrawn" : "none";
}

async function describeContacts(db: Db, contacts: ContactCore[], now: Date): Promise<ContactListRow[]> {
  if (!contacts.length) return [];
  const ids = contacts.map((c) => c.id);
  const userIds = [...new Set(contacts.map((c) => c.userId).filter((u): u is string => Boolean(u)))];
  const [consents, suppressions, users] = await Promise.all([
    db.marketingConsent.findMany({ where: { contactId: { in: ids } }, select: { contactId: true, unsubscribedAt: true } }),
    db.emailSuppression.findMany({ where: { email: { in: contacts.map((c) => c.email) }, liftedAt: null }, select: { email: true, reason: true } }),
    userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const suppressionBy = new Map(suppressions.map((s) => [s.email, s.reason as string]));
  const userBy = new Map(users.map((u) => [u.id, u.name]));
  const rows: ContactListRow[] = [];
  for (const c of contacts) {
    const mine = consents.filter((k) => k.contactId === c.id);
    const suppression = suppressionBy.get(c.email) ?? null;
    const verdict = await getMarketingEligibility(c.email, { db, now }); // THE eligibility rule; nothing here re-derives it
    rows.push({
      id: c.id, email: c.email, name: c.name, source: c.source, isActive: c.isActive, createdAt: c.createdAt.toISOString(),
      customer: c.userId && userBy.has(c.userId) ? { id: c.userId, name: userBy.get(c.userId) as string } : null,
      consentStatus: consentStatusOf({ hasOpen: mine.some((k) => k.unsubscribedAt == null), hasClosed: mine.some((k) => k.unsubscribedAt != null), suppression }),
      suppressionReason: suppression,
      eligibility: verdict.eligible ? { eligible: true } : { eligible: false, reason: verdict.reason },
    });
  }
  return rows;
}

export async function adminListEmailContacts(actorId: unknown, query: { q?: unknown; filter?: unknown; page?: unknown } = {}, opts: Opts = {}): Promise<ContactListResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  const filter = parseContactFilter(query.filter);
  const q = parseContactSearch(query.q);
  const where = await buildWhere(db, filter, q);
  const total = await db.emailContact.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / CONTACTS_PAGE_SIZE));
  const page = Math.min(parseContactPage(query.page), pageCount);
  const contacts = await db.emailContact.findMany({
    where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * CONTACTS_PAGE_SIZE, take: CONTACTS_PAGE_SIZE,
    select: { id: true, email: true, name: true, source: true, isActive: true, createdAt: true, userId: true },
  });
  return { rows: await describeContacts(db, contacts, now), total, page, pageCount, pageSize: CONTACTS_PAGE_SIZE, filter, q };
}

// ------------------------------------------------------------------------------------------------------------------------------- detail

/** Everything on the contact details page. Selects named fields only: the unsubscribe token hash is never read. null for an unknown or malformed id. */
export async function adminGetEmailContactDetail(actorId: unknown, contactId: unknown, opts: Opts = {}): Promise<ContactDetail | null> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  if (!isRecordId(contactId)) return null;
  const c = await db.emailContact.findUnique({
    where: { id: contactId },
    select: { id: true, email: true, name: true, source: true, userId: true, isActive: true, createdById: true, createdAt: true },
  });
  if (!c) return null;
  const [consents, suppression, verdict] = await Promise.all([
    db.marketingConsent.findMany({
      where: { contactId: c.id }, orderBy: [{ grantedAt: "desc" }, { id: "desc" }],
      select: { id: true, source: true, grantedAt: true, evidence: true, recordedById: true, unsubscribedAt: true, unsubscribeSource: true },
    }),
    db.emailSuppression.findUnique({ where: { email: c.email }, select: { reason: true, note: true, createdAt: true, liftedAt: true } }),
    getMarketingEligibility(c.email, { db, now }),
  ]);
  const personIds = [...new Set([c.userId, c.createdById, ...consents.map((k) => k.recordedById)].filter((v): v is string => Boolean(v)))];
  const people = personIds.length ? await db.user.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true, email: true } }) : [];
  const person = new Map(people.map((p) => [p.id, p]));
  const activeSuppression = suppression && suppression.liftedAt == null ? suppression.reason : null;
  return {
    id: c.id, email: c.email, name: c.name, source: c.source, isActive: c.isActive, createdAt: c.createdAt.toISOString(),
    createdBy: c.createdById ? person.get(c.createdById)?.name ?? "A removed admin account" : null,
    customer: c.userId && person.has(c.userId) ? { id: c.userId, name: person.get(c.userId)!.name, email: person.get(c.userId)!.email } : null,
    consentStatus: consentStatusOf({ hasOpen: consents.some((k) => k.unsubscribedAt == null), hasClosed: consents.some((k) => k.unsubscribedAt != null), suppression: activeSuppression }),
    eligibility: verdict.eligible ? { eligible: true } : { eligible: false, reason: verdict.reason },
    consents: consents.map((k) => ({
      id: k.id, source: k.source, grantedAt: k.grantedAt.toISOString(), evidence: k.evidence,
      recordedBy: k.recordedById ? person.get(k.recordedById)?.name ?? "A removed admin account" : null,
      unsubscribedAt: k.unsubscribedAt ? k.unsubscribedAt.toISOString() : null, unsubscribeSource: k.unsubscribeSource ?? null, open: k.unsubscribedAt == null,
    })),
    suppression: suppression
      ? { reason: suppression.reason, note: suppression.note, createdAt: suppression.createdAt.toISOString(), active: suppression.liftedAt == null, liftedAt: suppression.liftedAt ? suppression.liftedAt.toISOString() : null }
      : null,
  };
}

// ----------------------------------------------------------------------------------------------------------------------- activate / deactivate

export async function adminSetEmailContactActive(actorId: unknown, contactId: unknown, isActive: unknown, opts: Opts = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  const db = opts.db ?? prisma;
  await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  if (!isRecordId(contactId) || typeof isActive !== "boolean") return { ok: false, message: "Contact not found." };
  const res = await setEmailContactActive(contactId, isActive, { db });
  return res.ok ? { ok: true } : { ok: false, message: "Contact not found." };
}

export async function adminSetEmailContactsActive(actorId: unknown, contactIds: unknown, isActive: unknown, opts: Opts = {}): Promise<{ ok: true; updated: number; missing: number } | { ok: false; message: string }> {
  const db = opts.db ?? prisma;
  await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  if (typeof isActive !== "boolean") return { ok: false, message: "Choose activate or deactivate." };
  if (!Array.isArray(contactIds) || contactIds.length === 0 || contactIds.length > MAX_BULK_IDS || !contactIds.every(isRecordId)) {
    return { ok: false, message: `Select between 1 and ${MAX_BULK_IDS} contacts.` };
  }
  let updated = 0;
  let missing = 0;
  for (const id of new Set(contactIds as string[])) {
    const res = await setEmailContactActive(id, isActive, { db });
    if (res.ok) updated++; else missing++;
  }
  return { ok: true, updated, missing };
}

// ------------------------------------------------------------------------------------------------------------ consent management (existing contact)

export type ConsentChangeResult =
  | { ok: true; outcome: "recorded" | "already_on_file" | "withdrawn" | "nothing_to_withdraw"; message: string }
  | { ok: false; code: "not_found" | "invalid_input" | "blocked_suppressed" | "blocked_inactive" | "failed"; field?: "evidence" | "attest" | "note"; message: string };

const consentAudit = async (db: Db, actorId: string, action: string, contactId: string, detail: Record<string, unknown>) => {
  try { await recordAudit(db, { actorId, action, entityType: "EmailContact", entityId: contactId, detail }); } catch (error) { logServerError("email-contacts.consent-audit", error); }
};

/**
 * An admin records that an EXISTING contact explicitly agreed to marketing e-mail. It is only the existing recordMarketingConsent (P08), with:
 *  - source fixed to ADMIN_RECORDED (never chosen by the browser) and the time taken from the server clock, not from the form;
 *  - written evidence REQUIRED (checkConsentEvidence) and an explicit attestation that the admin holds that evidence (`attest` must be exactly true);
 *  - neverLiftSuppression: ANY active suppression (unsubscribed, bounced, complained, admin block, or one that cannot be read) refuses the consent inside
 *    the consent transaction, so this screen can never make a suppressed address eligible; an inactive contact is refused too.
 * History is append-only: a new opt-in is a new row, an open consent is never rewritten, and calling this again changes nothing ("already_on_file").
 * Every attempt, also a refused one, is audited (actor, contact, outcome code; never the evidence text or the address). Never sends or enqueues anything.
 */
export async function adminRecordContactConsent(actorId: unknown, contactId: unknown, input: { evidence?: unknown; attest?: unknown } = {}, opts: Opts = {}): Promise<ConsentChangeResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const adminId = await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  if (!isRecordId(contactId)) return { ok: false, code: "not_found", message: "Contact not found." };
  const body = input && typeof input === "object" ? input : {};
  if (body.attest !== true) return { ok: false, code: "invalid_input", field: "attest", message: "Confirm that you hold the evidence that this person agreed to receive marketing e-mail." };
  const evidence = checkConsentEvidence(body.evidence);
  if (!evidence.ok) return { ok: false, code: "invalid_input", field: "evidence", message: evidence.message };
  const contact = await db.emailContact.findUnique({ where: { id: contactId }, select: { id: true } });
  if (!contact) return { ok: false, code: "not_found", message: "Contact not found." };

  let res: Awaited<ReturnType<typeof recordMarketingConsent>>;
  try {
    res = await recordMarketingConsent(contact.id, { source: "ADMIN_RECORDED", evidence: evidence.value, recordedById: adminId }, { db, now, neverLiftSuppression: true });
  } catch (error) {
    logServerError("email-contacts.consent-record", error);
    await consentAudit(db, adminId, "email_contact.consent_record_failed", contact.id, { outcome: "failed" });
    return { ok: false, code: "failed", message: "Consent could not be recorded. Please try again." };
  }
  if (!res.ok) {
    const code = res.reason === "suppressed" ? "blocked_suppressed" : res.reason === "inactive" ? "blocked_inactive" : res.reason === "no_contact" ? "not_found" : "failed";
    await consentAudit(db, adminId, "email_contact.consent_record_refused", contact.id, { outcome: code });
    const message = code === "blocked_suppressed"
      ? "Consent was NOT recorded: this address is suppressed (unsubscribed, bounced, complained or blocked) and a suppression cannot be lifted from here."
      : code === "blocked_inactive" ? "Consent was NOT recorded: the contact is inactive. Activate it first." : code === "not_found" ? "Contact not found." : "Consent could not be recorded. Please try again.";
    return { ok: false, code, message };
  }
  await consentAudit(db, adminId, "email_contact.consent_record", contact.id, { outcome: res.created ? "recorded" : "already_on_file", consentId: res.consentId, source: "ADMIN_RECORDED" });
  return res.created
    ? { ok: true, outcome: "recorded", message: "Marketing consent was recorded with your evidence." }
    : { ok: true, outcome: "already_on_file", message: "Marketing consent was already on file; nothing changed." };
}

/**
 * An admin records that an existing contact has WITHDRAWN marketing consent. It is only the existing withdrawMarketingConsent (P08), source ADMIN: the open
 * consent row is stamped as ended (never edited or deleted, so the history stays), the contact stops being eligible at once, and a later opt-in is a new row.
 * It does not create a suppression and cannot touch one. Idempotent. The optional note is kept in the audit event only (the consent table has no column for it).
 */
export async function adminWithdrawContactConsent(actorId: unknown, contactId: unknown, input: { note?: unknown } = {}, opts: Opts = {}): Promise<ConsentChangeResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const adminId = await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  if (!isRecordId(contactId)) return { ok: false, code: "not_found", message: "Contact not found." };
  const body = input && typeof input === "object" ? input : {};
  const note = cleanOptionalText(body.note, MAX_EVIDENCE_LENGTH);
  if (!note.ok) return { ok: false, code: "invalid_input", field: "note", message: `The note can be at most ${MAX_EVIDENCE_LENGTH} characters.` };
  const contact = await db.emailContact.findUnique({ where: { id: contactId }, select: { id: true } });
  if (!contact) return { ok: false, code: "not_found", message: "Contact not found." };

  let res: Awaited<ReturnType<typeof withdrawMarketingConsent>>;
  try {
    res = await withdrawMarketingConsent(contact.id, "ADMIN", { db, now });
  } catch (error) {
    logServerError("email-contacts.consent-withdraw", error);
    await consentAudit(db, adminId, "email_contact.consent_withdraw_failed", contact.id, { outcome: "failed" });
    return { ok: false, code: "failed", message: "The withdrawal could not be recorded. Please try again." };
  }
  if (!res.ok) return { ok: false, code: "failed", message: "The withdrawal could not be recorded. Please try again." };
  await consentAudit(db, adminId, "email_contact.consent_withdraw", contact.id, { outcome: res.withdrawn ? "withdrawn" : "nothing_to_withdraw", ...(res.consentId ? { consentId: res.consentId } : {}), ...(note.value ? { note: note.value } : {}) });
  return res.withdrawn
    ? { ok: true, outcome: "withdrawn", message: "Consent withdrawal was recorded. This contact will not receive marketing e-mail." }
    : { ok: true, outcome: "nothing_to_withdraw", message: "There was no open marketing consent to withdraw; nothing changed." };
}

// -------------------------------------------------------------------------------------------------------------------------- manual creation

export type CreateContactInput = { email?: unknown; name?: unknown; grantConsent?: unknown; consentEvidence?: unknown };
export type CreateContactResult =
  | { ok: true; created: boolean; contactId: string; email: string; consent: CreateContactOutcome; message: string }
  | { ok: false; field?: "email" | "name" | "grantConsent" | "consentEvidence"; message: string };

/**
 * Adds ONE contact by hand. Creating a contact never grants consent. Consent is recorded only when the admin ticks the box AND writes evidence, through
 * recordMarketingConsent (source ADMIN_RECORDED). An address under ANY active suppression (or one that cannot be checked) is never given consent from here, so
 * this form cannot lift an unsubscribe (decided inside the consent transaction, so it is race-free); an inactive contact is not reactivated. Re-adding an existing address changes no consent, suppression or status.
 */
export async function adminCreateEmailContact(actorId: unknown, input: CreateContactInput, opts: Opts = {}): Promise<CreateContactResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const adminId = await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  const body = input && typeof input === "object" ? input : {};

  const email = normalizeContactEmail(body.email);
  if (!email.ok) return { ok: false, field: "email", message: email.message };
  const name = cleanOptionalText(body.name, MAX_NAME_LENGTH);
  if (!name.ok) return { ok: false, field: "name", message: `The name can be at most ${MAX_NAME_LENGTH} characters.` };
  if (body.grantConsent !== undefined && typeof body.grantConsent !== "boolean") return { ok: false, field: "grantConsent", message: "Invalid consent value." };
  const wantsConsent = body.grantConsent === true;
  let evidence: string | null = null;
  if (wantsConsent) {
    const checked = checkConsentEvidence(body.consentEvidence);
    if (!checked.ok) return { ok: false, field: "consentEvidence", message: checked.message };
    evidence = checked.value;
  }

  const saved = await upsertEmailContact({ email: email.email, source: "MANUAL", name: name.value, createdById: adminId }, { db });
  if (!saved.ok) return { ok: false, field: saved.reason === "invalid_name" ? "name" : "email", message: saved.reason === "invalid_name" ? "The name is not valid." : "Enter one valid e-mail address (for example you@example.com)." };
  const { contact, created } = saved;

  let consent: CreateContactOutcome = "not_requested";
  if (wantsConsent) {
    // No separate "is it suppressed?" read first: that read could be stale by the time consent is written. The refusal is decided INSIDE the consent
    // service's own transaction (neverLiftSuppression), so no suppression, however recent, can be lifted from this form. It also fails closed on errors.
    const res = await recordMarketingConsent(contact.id, { source: "ADMIN_RECORDED", evidence, recordedById: adminId }, { db, now, neverLiftSuppression: true });
    if (res.ok) consent = res.created ? "recorded" : "already_on_file";
    else consent = res.reason === "suppressed" ? "blocked_suppressed" : res.reason === "inactive" ? "blocked_inactive" : "failed";
  }

  const lead = created ? "Contact added." : "This address was already a contact; its status, consent and suppression were left as they were.";
  const tail: Record<CreateContactOutcome, string> = {
    not_requested: created ? " No marketing consent was recorded, so it will not receive marketing e-mail." : "",
    recorded: " Marketing consent was recorded with your evidence.",
    already_on_file: " Marketing consent was already on file; nothing changed.",
    blocked_suppressed: " Consent was NOT recorded: this address is suppressed (unsubscribed, bounced, complained or blocked) and a suppression cannot be lifted from here.",
    blocked_inactive: " Consent was NOT recorded: the contact is inactive. Activate it from its details page first.",
    failed: " Consent could not be recorded. Please try again.",
  };
  return { ok: true, created, contactId: contact.id, email: contact.email, consent, message: `${lead}${tail[consent]}` };
}

// ------------------------------------------------------------------------------------------------------------------------------ CSV import

type ExistingInfo = { id: string; email: string; name: string | null; isActive: boolean };

async function lookupExisting(db: Db, emails: string[]): Promise<{ contacts: Map<string, ExistingInfo>; suppressed: Set<string> }> {
  const contacts = new Map<string, ExistingInfo>();
  const suppressed = new Set<string>();
  for (const part of chunksOf(emails, LOOKUP_CHUNK)) {
    for (const c of await db.emailContact.findMany({ where: { email: { in: part } }, select: { id: true, email: true, name: true, isActive: true } })) contacts.set(c.email, c);
    for (const s of await db.emailSuppression.findMany({ where: { email: { in: part }, liftedAt: null }, select: { email: true } })) suppressed.add(s.email);
  }
  return { contacts, suppressed };
}

const issuesOf = (rows: CsvRowPlan[]) => rows.filter((r) => r.status !== "valid").flatMap((r) => r.issues.map((message) => ({ row: r.row, message })));
const counts = (rows: CsvRowPlan[]) => ({
  totalRows: rows.length, validRows: rows.filter((r) => r.status === "valid").length,
  invalidRows: rows.filter((r) => r.status === "invalid").length, duplicateRows: rows.filter((r) => r.status === "duplicate").length,
});

/** Validates a CSV and shows what an import WOULD do. Writes nothing. */
export async function adminPreviewContactCsv(actorId: unknown, csv: unknown, opts: Opts = {}): Promise<{ ok: true; preview: CsvPreview } | { ok: false; message: string }> {
  const db = opts.db ?? prisma;
  await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  const plan = planCsv(parseCsv(csv));
  if (!plan.ok) return { ok: false, message: plan.message };
  const valid = plan.rows.filter((r) => r.status === "valid");
  const { contacts, suppressed } = await lookupExisting(db, valid.map((r) => r.email));

  let newContacts = 0, existingContacts = 0, consentRequested = 0, consentBlocked = 0;
  const outcomeOf = (r: CsvRowPlan): string => {
    if (r.status === "invalid") return "Will be skipped (invalid)";
    if (r.status === "duplicate") return `Will be skipped (duplicate of row ${r.duplicateOf})`;
    const existing = contacts.get(r.email);
    if (existing) existingContacts++; else newContacts++;
    let out = existing ? "Existing contact" : "New contact";
    if (r.consent === "explicit") {
      consentRequested++;
      if (suppressed.has(r.email) || existing?.isActive === false) { consentBlocked++; out += ", consent will be refused"; } else out += ", consent will be recorded";
    }
    return out;
  };
  const previewRows: CsvRowPreview[] = plan.rows.map((r) => ({ row: r.row, status: r.status, email: r.email, name: r.name, consent: r.consent, outcome: outcomeOf(r), issues: r.issues }));
  const issues = issuesOf(plan.rows);
  return {
    ok: true,
    preview: {
      ...counts(plan.rows), newContacts, existingContacts, consentRequested, consentBlocked,
      rows: previewRows.slice(0, CSV_PREVIEW_ROWS), issues: issues.slice(0, CSV_ISSUE_LIMIT), issuesTruncated: issues.length > CSV_ISSUE_LIMIT,
    },
  };
}

export type ImportOpts = Opts & { batchSize?: number; deadlineMs?: number; clock?: () => number };

/**
 * Imports a CSV in bounded batches. The file is parsed and validated AGAIN here (a preview is never trusted). Per valid row:
 *  - the contact is created/updated by upsertEmailContact (source CSV_IMPORT): an existing contact keeps its source, isActive, consent and suppression;
 *  - consent is requested ONLY for rows with marketing_consent exactly `true` and adequate evidence, and only when the admin attested that they hold it,
 *    through recordMarketingConsent (source CSV_IMPORT). An address under any active suppression (or an inactive contact) never reaches it;
 *    that service itself refuses to lift an unsubscribe for a CSV consent. Blank, false, missing or ambiguous consent creates nothing.
 * A run that hits its time budget stops cleanly and reports the rows it did not reach; importing the same file again is safe (idempotent).
 */
export async function adminImportContactCsv(
  actorId: unknown, csv: unknown, input: { attestConsent?: unknown } = {}, opts: ImportOpts = {},
): Promise<{ ok: true; summary: CsvImportSummary } | { ok: false; message: string }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const adminId = await assertAdminActor(db, typeof actorId === "string" ? actorId : null);
  const plan = planCsv(parseCsv(csv));
  if (!plan.ok) return { ok: false, message: plan.message };
  const valid = plan.rows.filter((r) => r.status === "valid");
  if (!valid.length) return { ok: false, message: "There are no valid rows to import." };
  if (valid.some((r) => r.consent === "explicit") && input?.attestConsent !== true) {
    return { ok: false, message: "Confirm that you hold the consent described in the evidence column before importing rows that record consent." };
  }
  const batchSize = Number.isInteger(opts.batchSize) && (opts.batchSize as number) >= 1 ? Math.min(opts.batchSize as number, 200) : IMPORT_BATCH;
  const deadline = clock() + (opts.deadlineMs ?? IMPORT_DEADLINE_MS);

  const s = { newContacts: 0, existingContacts: 0, existingUpdated: 0, consentRecorded: 0, consentAlreadyOnFile: 0, consentBlocked: 0, failed: 0, notProcessed: 0 };
  const notes: { row: number; message: string }[] = [];
  const batches = chunksOf(valid, batchSize);
  for (let b = 0; b < batches.length; b++) {
    if (clock() > deadline) { s.notProcessed += batches.slice(b).reduce((n, part) => n + part.length, 0); break; }
    const before = await lookupExisting(db, batches[b].map((r) => r.email));
    for (const row of batches[b]) {
      try {
        const saved = await upsertEmailContact({ email: row.email, source: "CSV_IMPORT", name: row.name, createdById: adminId }, { db });
        if (!saved.ok) { s.failed++; notes.push({ row: row.row, message: "The row could not be saved." }); continue; }
        if (saved.created) s.newContacts++;
        else {
          s.existingContacts++;
          const prior = before.contacts.get(row.email);
          if (row.name && prior && prior.name !== row.name) s.existingUpdated++;
        }
        if (row.consent !== "explicit") continue;
        const suppression = await checkEmailSuppression(saved.contact.email, { db }); // fails closed
        if (suppression.suppressed) { s.consentBlocked++; notes.push({ row: row.row, message: "Consent was not recorded: this address is suppressed." }); continue; }
        if (!saved.contact.isActive) { s.consentBlocked++; notes.push({ row: row.row, message: "Consent was not recorded: the contact is inactive." }); continue; }
        const res = await recordMarketingConsent(saved.contact.id, { source: "CSV_IMPORT", evidence: row.evidence, recordedById: adminId }, { db, now });
        if (res.ok) { if (res.created) s.consentRecorded++; else s.consentAlreadyOnFile++; }
        else if (res.reason === "suppressed" || res.reason === "inactive") { s.consentBlocked++; notes.push({ row: row.row, message: `Consent was not recorded: ${res.reason === "inactive" ? "the contact is inactive" : "this address is suppressed"}.` }); }
        else { s.failed++; notes.push({ row: row.row, message: "Consent could not be recorded." }); }
      } catch (error) {
        logServerError("email-contacts.csv-import-row", error); // no address or cell content is logged
        s.failed++;
        notes.push({ row: row.row, message: "The row could not be saved." });
      }
    }
  }

  const all = [...issuesOf(plan.rows), ...notes].sort((a, b) => a.row - b.row);
  const summary: CsvImportSummary = {
    ...counts(plan.rows), ...s, skippedOrBlocked: s.consentBlocked + s.failed + s.notProcessed,
    issues: all.slice(0, CSV_ISSUE_LIMIT), issuesTruncated: all.length > CSV_ISSUE_LIMIT,
  };
  try {
    await recordAudit(db, { actorId: adminId, action: "email_contacts.csv_import", entityType: "EmailContact", detail: { ...counts(plan.rows), ...s, consentAttested: input?.attestConsent === true } });
  } catch (error) {
    logServerError("email-contacts.csv-import-audit", error);
  }
  return { ok: true, summary };
}
