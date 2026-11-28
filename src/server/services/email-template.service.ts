import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  cleanSearch, cleanSingleLine, isRecordId, isTemplateCategory, normalizePagination, TEMPLATE_CATEGORIES, TEMPLATE_LIMITS, validateTemplateContent,
  type FieldError, type TemplateCategory,
} from "@/lib/email/template-rules";
import { unsupportedFields } from "@/lib/email/campaign-rules";

type Db = typeof prisma;

/**
 * E-mail template management (Prompt 09). Templates live in the existing EmailTemplate table; "archived" means isActive = false (rows are never
 * deleted, so campaign history keeps pointing at them). Campaigns keep their OWN copy of subject and body (see EmailCampaign), so creating,
 * updating or archiving a template never changes an existing campaign or its templateId. Nothing here sends, queues or renders mail.
 *
 * Errors follow the e-mail marketing services: a result with `ok:false` and a fixed `reason`; `errors` lists field problems for `invalid_input`.
 * Only unexpected infrastructure failures throw.
 */

export type TemplateFailure =
  | { ok: false; reason: "invalid_input"; message: string; errors: FieldError[] }
  | { ok: false; reason: "not_found" | "template_archived" | "duplicate_name"; message: string };

export type EmailTemplateView = {
  id: string; name: string; category: TemplateCategory; subject: string; textBody: string; htmlBody: string | null;
  isActive: boolean; variables: string[]; createdAt: Date; updatedAt: Date;
};
export type EmailTemplateSummary = Pick<EmailTemplateView, "id" | "name" | "category" | "subject" | "isActive" | "createdAt" | "updatedAt">;

const TEMPLATE_FIELDS = ["name", "category", "subject", "textBody", "htmlBody"] as const;

type Row = { id: string; name: string; category: string; subject: string; textBody: string; htmlBody: string | null; isActive: boolean; createdAt: Date; updatedAt: Date };

function toView(row: Row): EmailTemplateView {
  const checked = validateTemplateContent(row);
  return {
    id: row.id, name: row.name, category: row.category as TemplateCategory, subject: row.subject, textBody: row.textBody, htmlBody: row.htmlBody,
    isActive: row.isActive, variables: checked.ok ? checked.variables : [], createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

const invalid = (errors: FieldError[]): TemplateFailure => ({ ok: false, reason: "invalid_input", message: errors[0]?.message ?? "Invalid input.", errors });
const isP2002 = (e: unknown) => (e as { code?: string })?.code === "P2002";
const DUPLICATE: TemplateFailure = { ok: false, reason: "duplicate_name", message: "A template with this name already exists." };

const cleanName = (raw: unknown) => cleanSingleLine(raw, "name", TEMPLATE_LIMITS.name, { required: true, label: "Template name" });

type Candidate = { name: unknown; category: unknown; subject: unknown; textBody: unknown; htmlBody: unknown };

/** Validates a complete template (name, category, content). */
function validateCandidate(c: Candidate): { ok: true; data: { name: string; category: TemplateCategory; subject: string; textBody: string; htmlBody: string | null } } | TemplateFailure {
  const errors: FieldError[] = [];
  const name = cleanName(c.name);
  if (!name.ok) errors.push(name.error);
  if (!isTemplateCategory(c.category)) errors.push({ field: "category", code: "invalid_category", message: `Category must be one of: ${TEMPLATE_CATEGORIES.join(", ")}.` });
  const content = validateTemplateContent({ subject: c.subject, textBody: c.textBody, htmlBody: c.htmlBody });
  if (!content.ok) errors.push(...content.errors);
  if (errors.length || !name.ok || !content.ok || !isTemplateCategory(c.category)) return invalid(errors);
  return { ok: true, data: { name: name.value as string, category: c.category, ...content.value } };
}

const asObject = (input: unknown): Record<string, unknown> | null => (input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null);

/** Creates a template (active). Name is unique (the database index decides, so two racing creates cannot both win). */
export async function createEmailTemplate(
  input: unknown,
  opts: { db?: Db; actorId?: string | null } = {},
): Promise<{ ok: true; template: EmailTemplateView } | TemplateFailure> {
  const obj = asObject(input);
  if (!obj) return invalid([{ field: "input", code: "invalid_type", message: "Template details are required." }]);
  const extra = unsupportedFields(obj, TEMPLATE_FIELDS);
  if (extra.length) return invalid(extra);
  const checked = validateCandidate({ name: obj.name, category: obj.category === undefined ? "MARKETING" : obj.category, subject: obj.subject, textBody: obj.textBody, htmlBody: obj.htmlBody });
  if (!checked.ok) return checked;
  try {
    const row = await (opts.db ?? prisma).emailTemplate.create({ data: { ...checked.data, createdById: opts.actorId ?? null } });
    return { ok: true, template: toView(row as Row) };
  } catch (e) {
    if (isP2002(e)) return DUPLICATE;
    throw e;
  }
}

/**
 * Updates the fields given (name, category, subject, textBody, htmlBody; htmlBody null/blank removes it). The MERGED template is validated, so a
 * partial change cannot leave an invalid whole. An archived template is not edited. isActive is not a field here (use archive). Existing campaigns
 * are untouched: they hold their own snapshot.
 */
export async function updateEmailTemplate(
  id: unknown,
  patch: unknown,
  opts: { db?: Db } = {},
): Promise<{ ok: true; template: EmailTemplateView; changed: boolean } | TemplateFailure> {
  if (!isRecordId(id)) return { ok: false, reason: "not_found", message: "Template not found." };
  const obj = asObject(patch);
  if (!obj) return invalid([{ field: "input", code: "invalid_type", message: "Template changes are required." }]);
  const extra = unsupportedFields(obj, TEMPLATE_FIELDS);
  if (extra.length) return invalid(extra);
  const given = TEMPLATE_FIELDS.filter((f) => obj[f] !== undefined);
  if (!given.length) return invalid([{ field: "input", code: "empty", message: "Nothing to change." }]);

  const db = opts.db ?? prisma;
  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const current = await tx.emailTemplate.findUnique({ where: { id } });
      if (!current) return { ok: false, reason: "not_found", message: "Template not found." } as const;
      if (!current.isActive) return { ok: false, reason: "template_archived", message: "An archived template cannot be edited." } as const;
      const merged: Candidate = {
        name: obj.name !== undefined ? obj.name : current.name, category: obj.category !== undefined ? obj.category : current.category,
        subject: obj.subject !== undefined ? obj.subject : current.subject, textBody: obj.textBody !== undefined ? obj.textBody : current.textBody,
        htmlBody: obj.htmlBody !== undefined ? obj.htmlBody : current.htmlBody,
      };
      const checked = validateCandidate(merged);
      if (!checked.ok) return checked;
      const same = (Object.keys(checked.data) as (keyof typeof checked.data)[]).every((k) => checked.data[k] === (current as Row)[k]);
      if (same) return { ok: true, template: toView(current as Row), changed: false } as const;
      // Guarded write: a concurrent archive makes this match nothing instead of editing an archived template.
      const res = await tx.emailTemplate.updateMany({ where: { id, isActive: true }, data: checked.data });
      if (res.count === 0) return { ok: false, reason: "template_archived", message: "An archived template cannot be edited." } as const;
      const fresh = await tx.emailTemplate.findUnique({ where: { id } });
      return { ok: true, template: toView(fresh as Row), changed: true } as const;
    });
  } catch (e) {
    if (isP2002(e)) return DUPLICATE; // another template took the name between the read and the write
    throw e;
  }
}

export async function getEmailTemplate(id: unknown, opts: { db?: Db } = {}): Promise<{ ok: true; template: EmailTemplateView } | TemplateFailure> {
  if (!isRecordId(id)) return { ok: false, reason: "not_found", message: "Template not found." };
  const row = await (opts.db ?? prisma).emailTemplate.findUnique({ where: { id } });
  return row ? { ok: true, template: toView(row as Row) } : { ok: false, reason: "not_found", message: "Template not found." };
}

export type ListEmailTemplatesInput = { page?: unknown; pageSize?: unknown; category?: unknown; isActive?: unknown; search?: unknown };
export type EmailTemplateList = { ok: true; items: EmailTemplateSummary[]; total: number; page: number; pageSize: number; totalPages: number };

/** Newest first, paginated. `isActive` omitted = active and archived; bodies are not included (use get). */
export async function listEmailTemplates(input: ListEmailTemplatesInput = {}, opts: { db?: Db } = {}): Promise<EmailTemplateList | TemplateFailure> {
  const errors: FieldError[] = [];
  const paging = normalizePagination(input);
  if (!paging.ok) errors.push(...paging.errors);
  if (input.category !== undefined && !isTemplateCategory(input.category)) errors.push({ field: "category", code: "invalid_category", message: `Category must be one of: ${TEMPLATE_CATEGORIES.join(", ")}.` });
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") errors.push({ field: "isActive", code: "invalid_type", message: "isActive must be true or false." });
  const search = cleanSearch(input.search);
  if (!search.ok) errors.push(...search.errors);
  if (errors.length || !paging.ok || !search.ok) return invalid(errors);

  const where: Prisma.EmailTemplateWhereInput = {};
  if (input.category !== undefined) where.category = input.category as TemplateCategory;
  if (input.isActive !== undefined) where.isActive = input.isActive as boolean;
  if (search.value) where.name = { contains: search.value, mode: "insensitive" };
  const db = opts.db ?? prisma;
  const [rows, total] = await Promise.all([
    db.emailTemplate.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: paging.skip, take: paging.pageSize }),
    db.emailTemplate.count({ where }),
  ]);
  const items = (rows as Row[]).map((r) => ({ id: r.id, name: r.name, category: r.category as TemplateCategory, subject: r.subject, isActive: r.isActive, createdAt: r.createdAt, updatedAt: r.updatedAt }));
  return { ok: true, items, total, page: paging.page, pageSize: paging.pageSize, totalPages: Math.max(1, Math.ceil(total / paging.pageSize)) };
}

/** Archives (isActive = false). Idempotent. Nothing is deleted and no campaign reference changes. New campaigns can no longer use it. */
export async function archiveEmailTemplate(id: unknown, opts: { db?: Db } = {}): Promise<{ ok: true; archived: boolean } | TemplateFailure> {
  if (!isRecordId(id)) return { ok: false, reason: "not_found", message: "Template not found." };
  const db = opts.db ?? prisma;
  const res = await db.emailTemplate.updateMany({ where: { id, isActive: true }, data: { isActive: false } });
  if (res.count > 0) return { ok: true, archived: true };
  const exists = await db.emailTemplate.findUnique({ where: { id }, select: { id: true } });
  return exists ? { ok: true, archived: false } : { ok: false, reason: "not_found", message: "Template not found." };
}
