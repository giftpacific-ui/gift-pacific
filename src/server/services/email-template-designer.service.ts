import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { logServerInfo } from "@/lib/logger";
import { consumeRateLimit, RATE_LIMITS, throttledMessage } from "@/lib/rate-limit";
import { maskEmail, validateRecipientEmail } from "@/lib/email/config";
import { readUnsubscribeBaseUrl } from "@/lib/email/unsubscribe-config";
import { sendSmtpMail, type TransportFactory } from "@/lib/email/smtp";
import { unsupportedFields } from "@/lib/email/campaign-rules";
import {
  cleanSearch, cleanSubject, cleanSingleLine, isRecordId, isTemplateCategory, renderEmailTemplate, scanPlaceholders, TEMPLATE_CATEGORIES, TEMPLATE_LIMITS,
  type FieldError, type TemplateCategory,
} from "@/lib/email/template-rules";
import {
  attachDesign, DESIGN_MARKER_PREFIX, hasUnsubscribePlaceholder, isDesignerTemplate, readStoredDesign, renderDesign, resolveImageUrl, stripDesignMarker, validateDesign, withDesignStatus,
  type DesignBrand, type DesignProduct, type DesignStatus, type RenderContext,
} from "@/lib/email/designer/design";
import { DESIGN_LIMITS, FIELD_SPEC, isBlockId, isBlockType, type Block, type Design, type FieldSpec } from "@/lib/email-template-blocks";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";
import { adminListProducts } from "@/server/services/admin-product.service";
import { archiveEmailTemplate, createEmailTemplate, getEmailTemplate, updateEmailTemplate } from "@/server/services/email-template.service";

type Db = typeof prisma;
type Env = Record<string, string | undefined>;
type Tx = Parameters<typeof assertAdminActor>[0];
type Opts = { db?: Db; env?: Env; factory?: TransportFactory };

/**
 * Admin side of the e-mail template designer (P12-UI-02). A THIN layer over the existing template service: templates are created and updated ONLY through
 * createEmailTemplate / updateEmailTemplate / archiveEmailTemplate (so name, category, subject, placeholder and unsafe-HTML rules are the existing ones),
 * and the page renders with the existing renderEmailTemplate. This file adds: the admin check, product look-ups, design validation + rendering, the
 * derived status, duplicate, a guarded delete, preview and the test e-mail.
 *
 * Status (no migration): ARCHIVED = isActive false (existing meaning); DRAFT = a designer template stored as "draft"; ACTIVE = every other active template.
 * Campaigns keep their own snapshot (EmailCampaign.subject/textBody/htmlBody), so nothing here can change a campaign that already exists.
 * Nothing here creates consent, a contact, a campaign, a recipient or a queued job. The test e-mail goes straight to the SMTP service to ONE typed address.
 */

export type DesignerFailure = { ok: false; code: string; message: string; errors?: FieldError[] };
const fail = (code: string, message: string, errors?: FieldError[]): DesignerFailure => ({ ok: false, code, message, ...(errors ? { errors } : {}) });
const FORBIDDEN = fail("forbidden", "You are not authorised to do this.");
const NOT_FOUND = fail("not_found", "Template not found.");
const GENERIC_SAVE = "The template could not be saved. Please try again.";

async function admin(db: Db, adminId: unknown): Promise<string | null> {
  try { return await assertAdminActor(db as unknown as Tx, typeof adminId === "string" ? adminId : null); } catch { return null; }
}
const audit = (db: Db, actorId: string, action: string, entityId: string | null, detail: Record<string, unknown>) =>
  recordAudit(db as unknown as Parameters<typeof recordAudit>[0], { actorId, action, entityType: "EmailTemplate", entityId, detail }).catch(() => undefined);

export type TemplateStatus = "draft" | "active" | "archived";
export const TEMPLATE_STATUSES: TemplateStatus[] = ["active", "draft", "archived"];
const DRAFT_MARK = `${DESIGN_MARKER_PREFIX}draft:`;

// ---------------------------------------------------------------------------------------------------------------------------------- context

type Compiled = { ctx: RenderContext; origin: string; storeName: string };

async function loadBrand(db: Db, origin: string, production: boolean): Promise<DesignBrand & { storeName: string }> {
  const s = (await db.storeSettings.findUnique({ where: { id: "singleton" } })) as Record<string, unknown> | null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const primary = typeof s?.primaryColor === "string" && /^#[0-9a-fA-F]{6}$/.test(s.primaryColor) ? s.primaryColor.toLowerCase() : "#a63a5b";
  const logoCandidate = str(s?.logoUrl);
  // The store logo if it is a public https image; else the bundled logo on the PUBLIC site origin; else no logo (never a localhost / relative / optimizer URL).
  const pick = (raw: string | null) => { const r = raw ? resolveImageUrl(raw, { origin, production }) : null; return r?.ok ? r.url : null; };
  const logo = pick(logoCandidate) ?? pick(`${origin}/img/logo/logo.png`);
  const social = ([["Instagram", "instagramUrl"], ["Facebook", "facebookUrl"], ["WhatsApp", "whatsappUrl"], ["TikTok", "tiktokUrl"]] as const)
    .map(([label, key]): { label: string; url: string | null } => ({ label, url: str(s?.[key]) })).filter((x): x is { label: string; url: string } => x.url !== null);
  return {
    storeName: str(s?.storeName) ?? "Gift Pacific", logoUrl: logo, primary, currencyCode: str(s?.currencyCode) ?? "BDT", currencySymbol: str(s?.currencySymbol) ?? "৳",
    email: str(s?.storeEmail), phone: str(s?.storePhone), address: str(s?.storeAddress), social,
  };
}

type ProductRow = {
  id: string; name: string; slug: string; price: unknown; compareAtPrice: unknown; currency: string; status: string; type: string; isBoxProduct: boolean;
  images?: { url: string; isMain: boolean; sortOrder: number }[]; variants?: { price: unknown }[];
};

/** Reads products from the product table (price, original price, image and URL are NEVER taken from the browser). */
async function loadProducts(db: Db, ids: string[], origin: string, production: boolean): Promise<Map<string, DesignProduct>> {
  const out = new Map<string, DesignProduct>();
  if (!ids.length) return out;
  const rows = (await db.product.findMany({ where: { id: { in: ids } }, include: { images: true, variants: true } })) as unknown as ProductRow[];
  for (const r of rows) {
    if (r.status !== "ACTIVE" || r.isBoxProduct) continue; // only products the shop actually sells (and that have a public page)
    const variantPrices = r.type === "VARIANT" ? (r.variants ?? []).map((v) => Number(v.price)).filter((n) => Number.isFinite(n)) : [];
    const price = variantPrices.length ? Math.min(...variantPrices) : Number(r.price);
    if (!Number.isFinite(price)) continue;
    const compare = r.compareAtPrice == null ? null : Number(r.compareAtPrice);
    const imgs = [...(r.images ?? [])].sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.sortOrder - b.sortOrder);
    const img = imgs.length ? resolveImageUrl(imgs[0].url, { origin, production }) : null;
    out.set(r.id, {
      id: r.id, name: r.name, imageUrl: img?.ok ? img.url : null, price, fromPrice: new Set(variantPrices).size > 1,
      compareAtPrice: compare !== null && Number.isFinite(compare) && compare > price ? compare : null, currency: r.currency, url: `${origin}/products/${encodeURIComponent(r.slug)}`,
    });
  }
  return out;
}

type CompiledDesign = { design: Design; html: string; text: string; storeName: string; origin: string };

/** Validate the design, load brand + products + coupons, render. The ONE path from "what the browser sent" to "what will be stored or sent". */
async function compileDesign(db: Db, rawDesign: unknown, env: Env): Promise<{ ok: true; value: CompiledDesign } | DesignerFailure> {
  const base = readUnsubscribeBaseUrl(env);
  if (!base.ok) return fail("site_url_invalid", "The public site address (NEXT_PUBLIC_APP_URL) is missing or invalid, so links and images cannot be built.");
  const production = env.NODE_ENV === "production";
  const checked = validateDesign(rawDesign, { origin: base.origin, production });
  if (!checked.ok) return fail("invalid_design", checked.errors[0]?.message ?? "The design is not valid.", checked.errors);
  const { design, productIds } = checked.value;

  const products = await loadProducts(db, productIds, base.origin, production);
  const errors: FieldError[] = [];
  design.blocks.forEach((b, i) => { if (b.type === "product" && !products.has(String(b.productId))) errors.push({ field: `blocks[${i}].productId`, code: "product_unavailable", message: "This product is not available (it was removed or is not active). Choose another product." }); });
  const codes = [...new Set(design.blocks.filter((b) => b.type === "promo" && b.couponCode).map((b) => String(b.couponCode)))];
  if (codes.length) {
    const found = new Set(((await db.coupon.findMany({ where: { code: { in: codes }, isActive: true }, select: { code: true } })) as { code: string }[]).map((c) => c.code));
    design.blocks.forEach((b, i) => { if (b.type === "promo" && b.couponCode && !found.has(String(b.couponCode))) errors.push({ field: `blocks[${i}].couponCode`, code: "coupon_not_found", message: `Coupon "${b.couponCode}" does not exist or is not active. Create it under Coupons first.` }); });
  }
  if (errors.length) return fail("invalid_design", errors[0].message, errors);

  const brand = await loadBrand(db, base.origin, production);
  const ctx: RenderContext = { origin: base.origin, production, brand, products };
  const { html, text } = renderDesign(design, ctx);
  return { ok: true, value: { design, html, text, storeName: brand.storeName, origin: base.origin } };
}

const SAMPLE = { customerName: "Sir/Medam", firstName: "Sir/Medam", email: "customer@example.com" } as const;
const sampleValues = (storeName: string, origin: string) => ({ ...SAMPLE, storeName, unsubscribeUrl: `${origin}/unsubscribe/sample-preview-link` });

// ------------------------------------------------------------------------------------------------------------------------------------ listing

export type TemplateRowView = {
  id: string; name: string; category: TemplateCategory; subject: string; status: TemplateStatus; isDesigner: boolean; campaignCount: number; createdAt: Date; updatedAt: Date;
};
export type TemplateStats = { total: number; active: number; draft: number; archived: number };
export const TEMPLATES_PAGE_SIZE = 20;

function statusWhere(status: TemplateStatus | undefined): Prisma.EmailTemplateWhereInput {
  if (status === "archived") return { isActive: false };
  if (status === "draft") return { isActive: true, htmlBody: { contains: DRAFT_MARK } };
  if (status === "active") return { isActive: true, OR: [{ htmlBody: null }, { NOT: { htmlBody: { contains: DRAFT_MARK } } }] };
  return {};
}

export async function adminGetEmailTemplateStats(adminId: unknown, opts: Opts = {}): Promise<TemplateStats> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) throw new UserFacingError("You are not authorised to do this.");
  const [total, active, draft, archived] = await Promise.all([
    db.emailTemplate.count(), db.emailTemplate.count({ where: statusWhere("active") }), db.emailTemplate.count({ where: statusWhere("draft") }), db.emailTemplate.count({ where: statusWhere("archived") }),
  ]);
  return { total, active, draft, archived };
}

export async function adminListEmailTemplates(
  adminId: unknown, input: { q?: unknown; category?: unknown; status?: unknown; page?: unknown }, opts: Opts = {},
): Promise<{ rows: TemplateRowView[]; total: number; page: number; pageCount: number; q: string; category: TemplateCategory | null; status: TemplateStatus | null }> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) throw new UserFacingError("You are not authorised to do this.");
  const search = cleanSearch(input.q);
  const q = search.ok && search.value ? search.value : "";
  const category = isTemplateCategory(input.category) ? input.category : null;
  const status = TEMPLATE_STATUSES.find((s) => s === input.status) ?? null;
  const pageNum = Number(input.page);
  const page = Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= 100_000 ? pageNum : 1;

  const and: Prisma.EmailTemplateWhereInput[] = [statusWhere(status ?? undefined)];
  if (category) and.push({ category });
  if (q) and.push({ name: { contains: q, mode: "insensitive" } });
  const where: Prisma.EmailTemplateWhereInput = { AND: and };

  const [rows, total] = await Promise.all([
    db.emailTemplate.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (page - 1) * TEMPLATES_PAGE_SIZE, take: TEMPLATES_PAGE_SIZE, select: { id: true, name: true, category: true, subject: true, isActive: true, createdAt: true, updatedAt: true } }),
    db.emailTemplate.count({ where }),
  ]);
  const ids = rows.map((r) => r.id);
  const [drafts, designers, used] = ids.length
    ? await Promise.all([
        db.emailTemplate.findMany({ where: { id: { in: ids }, htmlBody: { contains: DRAFT_MARK } }, select: { id: true } }),
        db.emailTemplate.findMany({ where: { id: { in: ids }, htmlBody: { contains: DESIGN_MARKER_PREFIX } }, select: { id: true } }),
        db.emailCampaign.findMany({ where: { templateId: { in: ids } }, select: { templateId: true }, take: 5000 }),
      ])
    : [[], [], []];
  const draftSet = new Set(drafts.map((r) => r.id)), designerSet = new Set(designers.map((r) => r.id));
  const usedCount = new Map<string, number>();
  for (const c of used as { templateId: string | null }[]) if (c.templateId) usedCount.set(c.templateId, (usedCount.get(c.templateId) ?? 0) + 1);
  return {
    rows: rows.map((r) => ({
      id: r.id, name: r.name, category: r.category as TemplateCategory, subject: r.subject,
      status: !r.isActive ? "archived" : draftSet.has(r.id) ? "draft" : "active", isDesigner: designerSet.has(r.id), campaignCount: usedCount.get(r.id) ?? 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
    total, page, pageCount: Math.max(1, Math.ceil(total / TEMPLATES_PAGE_SIZE)), q, category, status,
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------ products

export type PickerProduct = {
  id: string; name: string; imageUrl: string | null; price: number; fromPrice: boolean; compareAtPrice: number | null; currency: string; priceLabel: string; compareAtLabel: string | null; url: string;
};

async function toPicker(db: Db, products: Map<string, DesignProduct>, origin: string, production: boolean): Promise<Map<string, PickerProduct>> {
  const brand = await loadBrand(db, origin, production);
  const money = (n: number, cur: string) => (cur === brand.currencyCode ? `${brand.currencySymbol}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)}` : `${cur} ${n}`);
  return new Map([...products].map(([id, p]) => [id, { ...p, priceLabel: `${p.fromPrice ? "From " : ""}${money(p.price, p.currency)}`, compareAtLabel: p.compareAtPrice === null ? null : money(p.compareAtPrice, p.currency) }]));
}

/** Search for the product picker. Reuses the existing admin product search, then keeps only products that can appear in an e-mail (active, with a public page). */
export async function adminSearchTemplateProducts(adminId: unknown, query: unknown, opts: Opts = {}): Promise<{ ok: true; products: PickerProduct[] } | DesignerFailure> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) return FORBIDDEN;
  const env = opts.env ?? process.env;
  const base = readUnsubscribeBaseUrl(env);
  if (!base.ok) return fail("site_url_invalid", "The public site address (NEXT_PUBLIC_APP_URL) is missing or invalid.");
  const s = cleanSingleLine(query, "search", 100, { required: false, label: "Search text" });
  if (!s.ok) return fail("invalid_search", s.error.message);
  const found = await adminListProducts({ search: s.value ?? undefined, page: 1, pageSize: 30 });
  const ids = found.items.filter((p) => p.status === "ACTIVE" && !p.isBoxProduct).map((p) => p.id).slice(0, 12);
  const production = env.NODE_ENV === "production";
  const picked = await toPicker(db, await loadProducts(db, ids, base.origin, production), base.origin, production);
  return { ok: true, products: ids.map((id) => picked.get(id)).filter((p): p is PickerProduct => !!p) };
}

// ----------------------------------------------------------------------------------------------------------------------------- load for editing

const BLANK_DESIGN: Design = { preheader: "", blocks: [] };

/** Loads a stored design for the editor without trusting it: unknown block types and fields are dropped and wrong types fall back to the block's defaults. */
export function coerceStoredDesign(raw: unknown): Design {
  if (!raw || typeof raw !== "object") return BLANK_DESIGN;
  const o = raw as Record<string, unknown>;
  const blocks: Block[] = [];
  const seen = new Set<string>();
  for (const rb of Array.isArray(o.blocks) ? o.blocks.slice(0, DESIGN_LIMITS.blocks) : []) {
    if (!rb || typeof rb !== "object") continue;
    const b = rb as Record<string, unknown>;
    if (!isBlockType(b.type)) continue;
    const id = isBlockId(b.id) && !seen.has(b.id) ? b.id : `r${blocks.length}x${Math.random().toString(36).slice(2, 7)}`;
    seen.add(id);
    const out: Block = { id, type: b.type };
    for (const [k, spec] of Object.entries(FIELD_SPEC[b.type]) as [string, FieldSpec][]) {
      const v = b[k];
      out[k] = spec.kind === "bool" ? (typeof v === "boolean" ? v : spec.def) : typeof v === "string" ? v : spec.def;
    }
    blocks.push(out);
  }
  return { preheader: typeof o.preheader === "string" ? o.preheader.slice(0, DESIGN_LIMITS.preheader) : "", blocks };
}

export type EditorTemplate = {
  id: string; name: string; category: TemplateCategory; subject: string; status: TemplateStatus; isDesigner: boolean; design: Design | null;
  products: Record<string, PickerProduct | null>; campaignCount: number;
};

export async function adminGetEmailTemplateForEditor(adminId: unknown, id: unknown, opts: Opts = {}): Promise<{ ok: true; template: EditorTemplate } | DesignerFailure> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) return FORBIDDEN;
  const got = await getEmailTemplate(id, { db });
  if (!got.ok) return NOT_FOUND;
  const t = got.template;
  const stored = readStoredDesign(t.htmlBody);
  const design = stored ? coerceStoredDesign(stored.design) : null;
  const products: Record<string, PickerProduct | null> = {};
  if (design) {
    const ids = [...new Set(design.blocks.filter((b) => b.type === "product").map((b) => String(b.productId)).filter(isBlockId))];
    const env = opts.env ?? process.env;
    const base = readUnsubscribeBaseUrl(env);
    if (base.ok && ids.length) {
      const production = env.NODE_ENV === "production";
      const picked = await toPicker(db, await loadProducts(db, ids, base.origin, production), base.origin, production);
      for (const pid of ids) products[pid] = picked.get(pid) ?? null;
    }
  }
  const campaignCount = await db.emailCampaign.count({ where: { templateId: t.id } });
  return { ok: true, template: { id: t.id, name: t.name, category: t.category, subject: t.subject, status: !t.isActive ? "archived" : stored?.status === "draft" ? "draft" : "active", isDesigner: !!stored, design, products, campaignCount } };
}

// -------------------------------------------------------------------------------------------------------------------------------------- save

const SAVE_FIELDS = ["id", "name", "category", "subject", "status", "design"] as const;
const MAX_INPUT_CHARS = 150_000;

export async function adminSaveEmailTemplate(adminId: unknown, input: unknown, opts: Opts = {}): Promise<{ ok: true; id: string; status: TemplateStatus; created: boolean; message: string } | DesignerFailure> {
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Template details are required.");
  let size = 0;
  try { size = JSON.stringify(input).length; } catch { return fail("invalid_input", "Template details are not valid."); }
  if (size > MAX_INPUT_CHARS) return fail("too_large", "The template is too large to save.");
  const obj = input as Record<string, unknown>;
  const extra = unsupportedFields(obj, SAVE_FIELDS);
  if (extra.length) return fail("invalid_input", extra[0].message, extra);

  const errors: FieldError[] = [];
  const name = cleanSingleLine(obj.name, "name", TEMPLATE_LIMITS.name, { required: true, label: "Template name" });
  if (!name.ok) errors.push(name.error);
  const category = obj.category === undefined ? "MARKETING" : obj.category;
  if (!isTemplateCategory(category)) errors.push({ field: "category", code: "invalid_category", message: `Category must be one of: ${TEMPLATE_CATEGORIES.join(", ")}.` });
  const subject = cleanSubject(obj.subject);
  if (!subject.ok) errors.push(subject.error);
  else if (scanPlaceholders(subject.value as string).variables.includes("unsubscribeUrl")) errors.push({ field: "subject", code: "unsubscribe_url_in_subject", message: "{{unsubscribeUrl}} must not be used in the subject." });
  const status: DesignStatus | null = obj.status === "draft" || obj.status === "ready" ? obj.status : null;
  if (!status) errors.push({ field: "status", code: "invalid_status", message: "Status must be draft or ready." });
  if (obj.id !== undefined && !isRecordId(obj.id)) return NOT_FOUND;
  if (errors.length || !name.ok || !subject.ok || !status || !isTemplateCategory(category)) return fail("invalid_input", errors[0]?.message ?? "Invalid input.", errors);

  // An existing template must be one the designer made (the designer cannot rewrite hand-written HTML) and must not be archived.
  if (obj.id !== undefined) {
    const current = await getEmailTemplate(obj.id, { db });
    if (!current.ok) return NOT_FOUND;
    if (!current.template.isActive) return fail("template_archived", "An archived template cannot be edited.");
    if (!isDesignerTemplate(current.template.htmlBody)) return fail("not_designer_template", "This template was not created in the designer, so it cannot be edited here. Create a new design instead.");
  }

  const compiled = await compileDesign(db, obj.design, opts.env ?? process.env);
  if (!compiled.ok) return compiled;
  const { design, html, text } = compiled.value;
  const content = { name: name.value as string, category, subject: subject.value as string, textBody: text, htmlBody: attachDesign(html, design, status) };
  // The unsubscribe rule, checked on the exact bodies that will be stored (defence in depth: the footer always renders it).
  if (!hasUnsubscribePlaceholder(content)) return fail("unsubscribe_missing", "The template must contain the {{unsubscribeUrl}} link, so it cannot be saved.");

  try {
    if (obj.id === undefined) {
      const res = await createEmailTemplate(content, { db, actorId: actor });
      if (!res.ok) return mapTemplateFailure(res);
      await audit(db, actor, "EMAIL_TEMPLATE_CREATED", res.template.id, { status, blocks: design.blocks.length });
      return { ok: true, id: res.template.id, status: status === "draft" ? "draft" : "active", created: true, message: status === "draft" ? "Draft saved." : "Template saved and ready for campaigns." };
    }
    const res = await updateEmailTemplate(obj.id, content, { db });
    if (!res.ok) return mapTemplateFailure(res);
    await audit(db, actor, "EMAIL_TEMPLATE_UPDATED", res.template.id, { status, blocks: design.blocks.length, changed: res.changed });
    return { ok: true, id: res.template.id, status: status === "draft" ? "draft" : "active", created: false, message: `${status === "draft" ? "Draft updated" : "Template updated and ready for campaigns"}. Campaigns already created keep their own copy.` };
  } catch {
    return fail("save_failed", GENERIC_SAVE);
  }
}

function mapTemplateFailure(f: { ok: false; reason: string; message: string; errors?: FieldError[] }): DesignerFailure {
  return fail(f.reason, f.message, f.errors);
}

// ------------------------------------------------------------------------------------------------------------------ duplicate, archive, delete

export async function adminDuplicateEmailTemplate(adminId: unknown, id: unknown, opts: Opts = {}): Promise<{ ok: true; id: string; name: string } | DesignerFailure> {
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  const got = await getEmailTemplate(id, { db });
  if (!got.ok) return NOT_FOUND;
  const t = got.template;
  const html = t.htmlBody === null ? null : withDesignStatus(t.htmlBody, "draft");
  if (html === null) return fail("not_designer_template", "Only templates created in the designer can be duplicated here.");
  const suffix = (n: number) => (n === 1 ? " (copy)" : ` (copy ${n})`);
  for (let n = 1; n <= 25; n++) {
    const name = `${t.name.slice(0, TEMPLATE_LIMITS.name - suffix(n).length).trimEnd()}${suffix(n)}`;
    try {
      const res = await createEmailTemplate({ name, category: t.category, subject: t.subject, textBody: t.textBody, htmlBody: html }, { db, actorId: actor });
      if (res.ok) { await audit(db, actor, "EMAIL_TEMPLATE_DUPLICATED", res.template.id, { from: t.id }); return { ok: true, id: res.template.id, name }; }
      if (res.reason !== "duplicate_name") return mapTemplateFailure(res);
    } catch { return fail("save_failed", "The template could not be duplicated. Please try again."); }
  }
  return fail("duplicate_name", "Could not find a free name for the copy. Rename an existing copy first.");
}

export async function adminArchiveEmailTemplate(adminId: unknown, id: unknown, opts: Opts = {}): Promise<{ ok: true; archived: boolean } | DesignerFailure> {
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  const res = await archiveEmailTemplate(id, { db });
  if (!res.ok) return mapTemplateFailure(res);
  if (res.archived) await audit(db, actor, "EMAIL_TEMPLATE_ARCHIVED", typeof id === "string" ? id : null, {});
  return res;
}

/** Deletes a template ONLY when no campaign was ever created from it (a campaign keeps its own copy of the content, but its template link is history worth keeping). */
export async function adminDeleteEmailTemplate(adminId: unknown, id: unknown, opts: Opts = {}): Promise<{ ok: true } | DesignerFailure> {
  const db = opts.db ?? prisma;
  const actor = await admin(db, adminId);
  if (!actor) return FORBIDDEN;
  if (!isRecordId(id)) return NOT_FOUND;
  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const t = await tx.emailTemplate.findUnique({ where: { id }, select: { id: true, name: true } });
      if (!t) return NOT_FOUND;
      const used = await tx.emailCampaign.count({ where: { templateId: id } });
      if (used > 0) return fail("template_in_use", `This template is used by ${used} campaign${used === 1 ? "" : "s"}. Archive it instead; campaign history is kept.`);
      const res = await tx.emailTemplate.deleteMany({ where: { id } });
      if (res.count === 0) return NOT_FOUND;
      await audit(db, actor, "EMAIL_TEMPLATE_DELETED", id, { name: t.name });
      return { ok: true } as const;
    });
  } catch {
    return fail("delete_failed", "The template could not be deleted. It may be in use; archive it instead.");
  }
}

// ----------------------------------------------------------------------------------------------------------------------------- preview + test

export type RenderedPreview = { subject: string; html: string; text: string };

function renderSample(content: { subject: string; textBody: string; htmlBody: string | null }, storeName: string, origin: string): RenderedPreview | DesignerFailure {
  // The preview and the test e-mail are what a customer would see: the stored designer marker is internal and is never part of it.
  const r = renderEmailTemplate({ ...content, htmlBody: stripDesignMarker(content.htmlBody) }, sampleValues(storeName, origin));
  if (!r.ok) return fail("invalid_template", r.errors[0]?.message ?? "The template is not valid.", r.errors);
  const escapeText = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return { subject: r.subject, text: r.textBody, html: r.htmlBody ?? `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;padding:16px">${escapeText(r.textBody)}</pre>` };
}

async function storeNameAndOrigin(db: Db, env: Env): Promise<{ storeName: string; origin: string } | DesignerFailure> {
  const base = readUnsubscribeBaseUrl(env);
  if (!base.ok) return fail("site_url_invalid", "The public site address (NEXT_PUBLIC_APP_URL) is missing or invalid.");
  const brand = await loadBrand(db, base.origin, env.NODE_ENV === "production");
  return { storeName: brand.storeName, origin: base.origin };
}

/** Preview of the CURRENT (possibly unsaved) design: the real generated e-mail, filled with sample customer data. Writes nothing and sends nothing. */
export async function adminPreviewEmailDesign(adminId: unknown, input: unknown, opts: Opts = {}): Promise<({ ok: true } & RenderedPreview) | DesignerFailure> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) return FORBIDDEN;
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!obj) return fail("invalid_input", "Design details are required.");
  const compiled = await compileDesign(db, obj.design, opts.env ?? process.env);
  if (!compiled.ok) return compiled;
  const subject = cleanSubject(typeof obj.subject === "string" && obj.subject.trim() ? obj.subject : "Preview");
  const r = renderSample({ subject: subject.ok ? (subject.value as string) : "Preview", textBody: compiled.value.text, htmlBody: compiled.value.html }, compiled.value.storeName, compiled.value.origin);
  return "ok" in r ? r : { ok: true, ...r };
}

/** Preview of a SAVED template exactly as stored (any template, including ones not made in the designer). */
export async function adminPreviewSavedEmailTemplate(adminId: unknown, id: unknown, opts: Opts = {}): Promise<({ ok: true; name: string; status: TemplateStatus; isDesigner: boolean } & RenderedPreview) | DesignerFailure> {
  const db = opts.db ?? prisma;
  if (!(await admin(db, adminId))) return FORBIDDEN;
  const got = await getEmailTemplate(id, { db });
  if (!got.ok) return NOT_FOUND;
  const ctx = await storeNameAndOrigin(db, opts.env ?? process.env);
  if ("ok" in ctx) return ctx;
  const t = got.template;
  const r = renderSample({ subject: t.subject, textBody: t.textBody, htmlBody: t.htmlBody }, ctx.storeName, ctx.origin);
  if ("ok" in r) return r;
  const stored = readStoredDesign(t.htmlBody);
  return { ok: true, name: t.name, status: !t.isActive ? "archived" : stored?.status === "draft" ? "draft" : "active", isDesigner: !!stored, ...r };
}

export type TestEmailResult = { success: true; message: string } | { success: false; code: string; message: string };

/**
 * "Send test email": renders the template with SAMPLE customer data and sends ONE message to the address the admin typed, through the existing SMTP
 * service (sendSmtpMail). No campaign, consent, contact, recipient or queue job is created, and no List-Unsubscribe header is added: the {{unsubscribeUrl}}
 * in a test is a clearly marked sample link that unsubscribes nobody. SMTP errors come back as the fixed messages of the SMTP service, never raw.
 */
export async function adminSendTemplateTestEmail(
  adminId: unknown, input: { recipient?: unknown; templateId?: unknown; subject?: unknown; design?: unknown }, opts: Opts = {},
): Promise<TestEmailResult> {
  const db = opts.db ?? prisma;
  const env = opts.env ?? process.env;
  const actor = await admin(db, adminId);
  if (!actor) return { success: false, code: "forbidden", message: "You are not authorised to do this." };
  const to = validateRecipientEmail(input?.recipient);
  if (!to.ok) return { success: false, code: "invalid_recipient", message: to.message };

  let preview: RenderedPreview | DesignerFailure;
  if (input.templateId !== undefined) {
    const got = await getEmailTemplate(input.templateId, { db });
    if (!got.ok) return { success: false, code: "not_found", message: "Template not found." };
    const ctx = await storeNameAndOrigin(db, env);
    if ("ok" in ctx) return { success: false, code: ctx.code, message: ctx.message };
    preview = renderSample({ subject: got.template.subject, textBody: got.template.textBody, htmlBody: got.template.htmlBody }, ctx.storeName, ctx.origin);
  } else {
    const compiled = await compileDesign(db, input.design, env);
    if (!compiled.ok) return { success: false, code: compiled.code, message: compiled.message };
    const subject = cleanSubject(input.subject);
    if (!subject.ok) return { success: false, code: "invalid_subject", message: subject.error.message };
    preview = renderSample({ subject: subject.value as string, textBody: compiled.value.text, htmlBody: compiled.value.html }, compiled.value.storeName, compiled.value.origin);
  }
  if ("ok" in preview) return { success: false, code: preview.code, message: preview.message };

  const limit = await consumeRateLimit(RATE_LIMITS.templateTestEmailAdmin, [actor]);
  if (!limit.ok) return { success: false, code: "throttled", message: throttledMessage(limit) };

  const subject = `[TEST] ${preview.subject}`.replace(/\s+/g, " ").slice(0, 200);
  const sent = await sendSmtpMail({ to: to.email, subject, text: preview.text, html: preview.html }, env, opts.factory);
  await audit(db, actor, "EMAIL_TEMPLATE_TEST_SENT", typeof input.templateId === "string" ? input.templateId : null, { recipient: maskEmail(to.email), outcome: sent.ok ? "accepted" : sent.code });
  if (sent.ok) {
    logServerInfo("email-template.test_sent", "Template test e-mail accepted by the SMTP server", { host: sent.host });
    return { success: true, message: `A test e-mail was sent to ${to.email}. Check that inbox (and the spam folder). Sample customer data was used.` };
  }
  return { success: false, code: sent.code, message: sent.message };
}


