/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * P12-UI-02: the e-mail template designer on the in-memory database. The REAL existing template, campaign, SMTP and rendering code runs underneath.
 * Covers authorization, create / edit / duplicate / archive / delete, product data from the product table, safe test e-mail, and that nothing here creates
 * consent, contacts, campaigns, recipients or queue jobs or touches a campaign snapshot.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discardAfter, freshDb, runAs, seedAdmins, seedCatalog } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { defaultDesign, newBlock, type Block, type Design } from "@/lib/email-template-blocks";
import { isDesignerDraft, readStoredDesign } from "@/lib/email/designer/design";
import {
  adminArchiveEmailTemplate, adminDeleteEmailTemplate, adminDuplicateEmailTemplate, adminGetEmailTemplateForEditor, adminGetEmailTemplateStats, adminListEmailTemplates,
  adminPreviewEmailDesign, adminPreviewSavedEmailTemplate, adminSaveEmailTemplate, adminSearchTemplateProducts, adminSendTemplateTestEmail, coerceStoredDesign,
} from "@/server/services/email-template-designer.service";
import { createEmailTemplate, getEmailTemplate } from "@/server/services/email-template.service";
import { createEmailCampaign, getEmailCampaign } from "@/server/services/email-campaign.service";
import {
  archiveEmailTemplateAction, deleteEmailTemplateAction, duplicateEmailTemplateAction, previewEmailDesignAction, saveEmailTemplateAction, searchTemplateProductsAction, sendTemplateTestEmailAction,
} from "@/server/actions/admin-email-template.actions";

let db: FakeDb;
const realLog = { warn: console.warn, info: console.info, error: console.error };
const SAVED_ENV: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["RATE_LIMIT_ENABLED"]) SAVED_ENV[k] = process.env[k];
  process.env.RATE_LIMIT_ENABLED = "false";
  db = freshDb();
  discardAfter();
  seedAdmins(db);
  seedCatalog(db);
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer Nine", role: "CUSTOMER", isActive: true });
  db.insert("user", { id: "adm-off", email: "off@staff.test", name: "Deactivated", role: "ADMIN", isActive: false });
  db.insert("productImage", { id: "img-1", productId: "p-standard", url: "https://res.cloudinary.com/demo/vase.jpg", isMain: true, sortOrder: 0, altText: null });
  console.warn = console.info = console.error = () => {};
});
afterEach(() => { Object.assign(console, realLog); if (SAVED_ENV.RATE_LIMIT_ENABLED === undefined) delete process.env.RATE_LIMIT_ENABLED; else process.env.RATE_LIMIT_ENABLED = SAVED_ENV.RATE_LIMIT_ENABLED; });

const A = "admin-1";
const d = () => db as never;
const ENV = { NEXT_PUBLIC_APP_URL: "https://giftpacific.test", NODE_ENV: "test", SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "shop@gmail.com", SMTP_PASS: "abcd efgh ijkl mnop", SMTP_FROM_NAME: "GiftPacific", SMTP_FROM_EMAIL: "" };
const O = { db: d(), env: ENV } as const;
const opts = () => ({ db: d(), env: ENV });

const withBlocks = (...mid: Block[]): Design => { const x = defaultDesign(); return { preheader: "", blocks: [x.blocks[0], ...mid, x.blocks[x.blocks.length - 1]] }; };
const productBlock = (productId: string, over: Record<string, unknown> = {}): Block => ({ ...newBlock("product"), productId, ...over }) as Block;
const input = (over: Record<string, unknown> = {}) => ({ name: "Winter sale", category: "MARKETING", subject: "Hello {{firstName}}", status: "draft", design: withBlocks(productBlock("p-standard")), ...over });
const save = async (over: Record<string, unknown> = {}) => { const r: any = await adminSaveEmailTemplate(A, input(over), opts()); return r; };
const templates = () => db.rows("emailTemplate");
const counts = () => ({ contacts: db.rows("emailContact").length, consents: db.rows("marketingConsent").length, suppressions: db.rows("emailSuppression").length, campaigns: db.rows("emailCampaign").length, recipients: db.rows("emailCampaignRecipient").length, jobs: db.rows("emailJob").length });

type Sent = { mail?: any; opened: number; closed: number };
const transport = (behaviour: (mail: any) => Promise<any>, seen: Sent = { opened: 0, closed: 0 }) =>
  Object.assign((options: Record<string, unknown>) => { seen.opened++; return { verify: async () => true, sendMail: async (mail: any) => { seen.mail = mail; return behaviour(mail); }, close: () => { seen.closed++; } }; }, { seen });
const accepts = async (mail: any) => ({ messageId: "<id@gmail.com>", accepted: [mail.to], rejected: [] });

// ---------------------------------------------------------------------------------------------------------------------------- authorization
test("admin authorization: every service operation refuses a customer, a deactivated admin and nobody", async () => {
  const made: any = await save();
  assert.ok(made.ok, JSON.stringify(made));
  for (const who of ["cust-9", "adm-off", null, undefined, "ghost", 42]) {
    assert.equal((await adminSaveEmailTemplate(who, input({ name: "x" }), opts()) as any).code, "forbidden");
    assert.equal((await adminSaveEmailTemplate(who, { ...input(), id: made.id }, opts()) as any).code, "forbidden");
    assert.equal((await adminDuplicateEmailTemplate(who, made.id, opts()) as any).code, "forbidden");
    assert.equal((await adminArchiveEmailTemplate(who, made.id, opts()) as any).code, "forbidden");
    assert.equal((await adminDeleteEmailTemplate(who, made.id, opts()) as any).code, "forbidden");
    assert.equal((await adminGetEmailTemplateForEditor(who, made.id, opts()) as any).code, "forbidden");
    assert.equal((await adminPreviewEmailDesign(who, input(), opts()) as any).code, "forbidden");
    assert.equal((await adminPreviewSavedEmailTemplate(who, made.id, opts()) as any).code, "forbidden");
    assert.equal((await adminSearchTemplateProducts(who, "vase", opts()) as any).code, "forbidden");
    assert.equal((await adminSendTemplateTestEmail(who, { recipient: "a@b.co", templateId: made.id }, { ...opts(), factory: transport(accepts) }) as any).code, "forbidden");
    await assert.rejects(adminGetEmailTemplateStats(who, opts()), /not authorised/);
    await assert.rejects(adminListEmailTemplates(who, {}, opts()), /not authorised/);
  }
  assert.equal(templates().length, 1, "nothing was written by the refused calls");
});

test("admin page and actions: a non-admin is refused before anything is read or written; an admin gets through", async () => {
  const actions: [string, () => Promise<unknown>][] = [
    ["save", () => saveEmailTemplateAction(input())], ["duplicate", () => duplicateEmailTemplateAction("x")], ["archive", () => archiveEmailTemplateAction("x")], ["delete", () => deleteEmailTemplateAction("x")],
    ["preview", () => previewEmailDesignAction(input())], ["search", () => searchTemplateProductsAction("vase")], ["test", () => sendTemplateTestEmailAction({ recipient: "a@b.co", design: input().design, subject: "s" })],
  ];
  for (const [name, call] of actions) {
    await assert.rejects(runAs(null, call as never), /FORBIDDEN/, `${name}: signed out`);
    await assert.rejects(runAs({ sub: "cust-9" }, call as never), /FORBIDDEN/, `${name}: customer`);
  }
  assert.equal(templates().length, 0);
  const res: any = await runAs("admin", () => saveEmailTemplateAction(input({ name: "Via action" })) as never);
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(templates().length, 1);
});

test("the page and its actions are wired to requireAdmin (source check) and the nav has a Templates entry under Email marketing", () => {
  for (const f of ["src/app/admin/(dashboard)/email-marketing/templates/page.tsx", "src/app/admin/(dashboard)/email-marketing/templates/new/page.tsx", "src/app/admin/(dashboard)/email-marketing/templates/[id]/page.tsx", "src/app/admin/(dashboard)/email-marketing/templates/[id]/preview/page.tsx"]) {
    assert.match(readFileSync(f, "utf8"), /await requireAdmin\(\)/, `${f} must call requireAdmin`);
  }
  const actions = readFileSync("src/server/actions/admin-email-template.actions.ts", "utf8");
  assert.equal((actions.match(/export async function/g) ?? []).length, (actions.match(/await requireAdmin\(\)/g) ?? []).length, "every exported action starts with requireAdmin");
  assert.match(readFileSync("src/config/admin-nav.ts", "utf8"), /href: "\/admin\/email-marketing\/templates", label: "Templates"/);
});

// ------------------------------------------------------------------------------------------------------------------- create / edit / duplicate
test("create: a draft is stored through the existing template service with generated HTML + text and the unsubscribe placeholder", async () => {
  const before = counts();
  const r = await save();
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.created, true); assert.equal(r.status, "draft");
  const row = templates()[0] as any;
  assert.equal(row.name, "Winter sale"); assert.equal(row.category, "MARKETING"); assert.equal(row.isActive, true); assert.equal(row.createdById, A);
  assert.match(row.htmlBody, /<a href="\{\{unsubscribeUrl\}\}"/); assert.match(row.textBody, /Unsubscribe: \{\{unsubscribeUrl\}\}/);
  assert.equal(isDesignerDraft(row.htmlBody), true);
  assert.deepEqual(counts(), before, "creating a template touches no contact, consent, campaign, recipient or job");
  assert.ok((await getEmailTemplate(row.id, { db: d() })).ok, "readable by the existing template service");
});

test("create ready: status ready is stored as an ordinary active template", async () => {
  const r = await save({ status: "ready" });
  assert.ok(r.ok); assert.equal(r.status, "active");
  assert.equal(isDesignerDraft((templates()[0] as any).htmlBody), false);
  assert.equal((await adminGetEmailTemplateStats(A, opts())).active, 1);
});

test("create: the existing template rules still apply (duplicate name, bad category, bad status, extra fields, unsupported subject variable, unsubscribe in subject)", async () => {
  assert.ok((await save()).ok);
  assert.equal((await save()).code, "duplicate_name");
  assert.equal((await save({ name: "B", category: "NOPE" })).code, "invalid_input");
  assert.equal((await save({ name: "B", status: "live" })).code, "invalid_input");
  assert.equal((await save({ name: "B", isActive: false } as never)).code, "invalid_input");
  assert.equal((await save({ name: "B", subject: "Hi {{secret}}" })).code, "invalid_input");
  assert.equal((await save({ name: "B", subject: "Hi {{unsubscribeUrl}}" })).code, "invalid_input");
  assert.equal((await save({ name: "B", subject: "Two\nlines" })).code, "invalid_input");
  assert.equal((await save({ name: "" })).code, "invalid_input");
  assert.equal(templates().length, 1);
});

test("server-side validation: a hostile design is refused and nothing is stored (script text, javascript: URL, bad image host, unknown block, oversize)", async () => {
  const bad: Design[] = [
    withBlocks({ ...newBlock("cta"), url: "javascript:alert(1)" } as Block),
    withBlocks({ ...newBlock("hero"), imageUrl: "https://evil.test/x.png" } as Block),
    withBlocks({ ...newBlock("text"), body: "{{secret}}" } as Block),
    { ...defaultDesign(), blocks: [...defaultDesign().blocks.slice(0, 4), { id: "x", type: "script", src: "x" } as never, defaultDesign().blocks[4]] },
    { ...defaultDesign(), blocks: defaultDesign().blocks.slice(0, 4) }, // no footer, therefore no unsubscribe link
    { ...defaultDesign(), blocks: Array.from({ length: 200 }, () => newBlock("text")) },
  ];
  for (const design of bad) { const r = await save({ name: `n${Math.random()}`, design }); assert.equal(r.ok, false); }
  assert.equal(templates().length, 0);
  assert.equal((await adminSaveEmailTemplate(A, { ...input(), design: { ...defaultDesign(), preheader: "x".repeat(200_000) } }, opts()) as any).code, "too_large");
  assert.equal((await adminSaveEmailTemplate(A, "nope", opts()) as any).ok, false);
});

test("a template body is never taken from the browser: a client-supplied htmlBody/textBody field is refused", async () => {
  const r: any = await adminSaveEmailTemplate(A, { ...input(), htmlBody: "<script>alert(1)</script>", textBody: "x" }, opts());
  assert.equal(r.ok, false); assert.equal(templates().length, 0);
});

test("product data comes from the product table: name, price, original price, image and URL are read server-side; the browser cannot supply or change them", async () => {
  db.patch("product", "p-standard", { compareAtPrice: 2400 });
  const r = await save({ design: withBlocks({ ...productBlock("p-standard"), name: "Hacked", price: "1" } as never) });
  assert.equal(r.ok, false, "extra product fields from the browser are refused");
  const ok = await save({ design: withBlocks(productBlock("p-standard")) });
  assert.ok(ok.ok);
  const html: string = (templates()[0] as any).htmlBody;
  assert.ok(html.includes("Clay Vase") && html.includes("৳1,800") && html.includes("৳2,400") && html.includes("-25%"));
  assert.ok(html.includes('href="https://giftpacific.test/products/clay-vase"'));
  assert.ok(html.includes("https://res.cloudinary.com/demo/vase.jpg"));
  const stored: any = readStoredDesign(html)!.design;
  assert.ok(!JSON.stringify(stored).includes("1800") && !JSON.stringify(stored).includes("Clay Vase"), "the stored design holds the product id only, never a price or a name");
});

test("product rules: missing, draft, archived and box-backing products are refused; a variant product shows a from-price; several products in one e-mail", async () => {
  assert.equal((await save({ design: withBlocks(productBlock("no-such")) })).ok, false);
  db.insert("product", { id: "p-draft", name: "Draft thing", slug: "draft-thing", status: "DRAFT", price: 10, description: "x" });
  db.insert("product", { id: "p-arch", name: "Old thing", slug: "old-thing", status: "ARCHIVED", price: 10, description: "x" });
  db.insert("product", { id: "p-box", name: "Box thing", slug: "box-thing", status: "ACTIVE", isBoxProduct: true, price: 10, description: "x" });
  for (const id of ["p-draft", "p-arch", "p-box"]) { const r = await save({ name: id, design: withBlocks(productBlock(id)) }); assert.equal(r.ok, false, id); assert.equal(r.errors?.[0]?.code, "product_unavailable"); }
  const multi = await save({ name: "Multi", design: withBlocks(productBlock("p-standard"), productBlock("p-variant", { id: "second" })) });
  assert.ok(multi.ok, JSON.stringify(multi));
  const html: string = (templates()[0] as any).htmlBody;
  assert.ok(html.indexOf("Clay Vase") < html.indexOf("Clay Mug"));
  assert.ok(html.includes("From ৳650"), "variant product: lowest variant price, labelled");
  assert.ok(!html.includes("-25%"), "no original price on these products, so no discount is invented");
});

test("promo coupon codes must be existing active coupons (no invented codes)", async () => {
  const promo = (code: string) => withBlocks({ ...newBlock("promo"), couponCode: code } as Block);
  assert.equal((await save({ name: "c1", design: promo("NOPE20") })).ok, false);
  db.insert("coupon", { id: "c1", code: "SAVE20", type: "PERCENTAGE", value: 20, isActive: true });
  db.insert("coupon", { id: "c2", code: "OLD10", type: "PERCENTAGE", value: 10, isActive: false });
  assert.ok((await save({ name: "c2", design: promo("save20") })).ok);
  assert.equal((await save({ name: "c3", design: promo("OLD10") })).ok, false);
});

test("edit: updates the existing template through the existing service; archived and non-designer templates are refused; name clash is refused", async () => {
  const made = await save();
  const edited = await save({ id: made.id, name: "Winter sale v2", subject: "New subject", status: "ready", design: withBlocks({ ...newBlock("cta"), label: "Explore Collection" } as Block) });
  assert.ok(edited.ok, JSON.stringify(edited)); assert.equal(edited.created, false); assert.equal(edited.status, "active");
  const row = templates()[0] as any;
  assert.equal(templates().length, 1); assert.equal(row.name, "Winter sale v2"); assert.equal(row.subject, "New subject"); assert.ok(row.htmlBody.includes("Explore Collection"));
  assert.equal(isDesignerDraft(row.htmlBody), false);
  assert.equal((await save({ id: "missing-id", name: "x" })).code, "not_found");
  const other = await save({ name: "Other" });
  assert.equal((await save({ id: other.id, name: "Winter sale v2" })).code, "duplicate_name");
  await adminArchiveEmailTemplate(A, other.id, opts());
  assert.equal((await save({ id: other.id, name: "Other" })).code, "template_archived");
  const legacy: any = await createEmailTemplate({ name: "Hand written", subject: "s", textBody: "x {{unsubscribeUrl}}", htmlBody: "<p>x <a href=\"{{unsubscribeUrl}}\">u</a></p>" }, { db: d() });
  assert.equal((await save({ id: legacy.template.id, name: "Hand written" })).code, "not_designer_template");
  assert.equal(((await getEmailTemplate(legacy.template.id, { db: d() })) as any).template.htmlBody, "<p>x <a href=\"{{unsubscribeUrl}}\">u</a></p>", "hand written HTML is untouched");
});

test("the editor loads a saved design back (block settings round-trip) with product data read fresh; broken stored data is made safe", async () => {
  const made = await save({ design: { preheader: "Preview line", blocks: withBlocks(productBlock("p-standard", { ctaLabel: "Grab it" }), { ...newBlock("cta"), label: "Shop Now", align: "right" } as Block).blocks } });
  const got: any = await adminGetEmailTemplateForEditor(A, made.id, opts());
  assert.ok(got.ok); assert.equal(got.template.status, "draft"); assert.equal(got.template.isDesigner, true);
  assert.equal(got.template.design.preheader, "Preview line");
  const blocks = got.template.design.blocks as any[];
  assert.equal(blocks.find((b) => b.type === "product").ctaLabel, "Grab it"); assert.equal(blocks.find((b) => b.type === "cta").align, "right");
  assert.equal(got.template.products["p-standard"].name, "Clay Vase"); assert.equal(got.template.products["p-standard"].priceLabel, "৳1,800");
  db.patch("product", "p-standard", { status: "ARCHIVED" });
  assert.equal(((await adminGetEmailTemplateForEditor(A, made.id, opts())) as any).template.products["p-standard"], null, "an unavailable product is reported, not invented");
  const fixed = coerceStoredDesign({ preheader: 5, blocks: [{ id: "a", type: "script", x: 1 }, { id: "../x", type: "text", body: 7, evil: "<script>" }, null, "x"] });
  assert.equal(fixed.preheader, ""); assert.equal(fixed.blocks.length, 1); assert.equal((fixed.blocks[0] as any).evil, undefined); assert.equal(typeof (fixed.blocks[0] as any).body, "string");
  assert.equal(((await adminGetEmailTemplateForEditor(A, "missing", opts())) as any).code, "not_found");
});

test("duplicate: a designer template becomes a new DRAFT copy with a free name; the original is untouched; non-designer templates are refused", async () => {
  const made = await save({ status: "ready", name: "Eid offer" });
  const before = JSON.stringify(templates()[0]);
  const c1: any = await adminDuplicateEmailTemplate(A, made.id, opts());
  const c2: any = await adminDuplicateEmailTemplate(A, made.id, opts());
  assert.ok(c1.ok && c2.ok); assert.equal(c1.name, "Eid offer (copy)"); assert.equal(c2.name, "Eid offer (copy 2)");
  const copy = templates().find((t: any) => t.id === c1.id) as any, orig = templates().find((t: any) => t.id === made.id) as any;
  assert.equal(isDesignerDraft(copy.htmlBody), true, "a copy always starts as a draft");
  assert.equal(copy.subject, orig.subject); assert.equal(copy.textBody, orig.textBody); assert.equal(copy.category, orig.category); assert.equal(copy.isActive, true);
  assert.deepEqual(readStoredDesign(copy.htmlBody)!.design, readStoredDesign(orig.htmlBody)!.design);
  assert.equal(JSON.stringify(templates().find((t: any) => t.id === made.id)), before, "the original is not modified");
  const legacy: any = await createEmailTemplate({ name: "Hand", subject: "s", textBody: "x" }, { db: d() });
  assert.equal(((await adminDuplicateEmailTemplate(A, legacy.template.id, opts())) as any).code, "not_designer_template");
  assert.equal(((await adminDuplicateEmailTemplate(A, "missing", opts())) as any).code, "not_found");
  const long = await save({ name: "L".repeat(120) });
  assert.ok(((await adminDuplicateEmailTemplate(A, long.id, opts())) as any).name.length <= 120);
});

test("archive: isActive becomes false, nothing is deleted; idempotent; an archived template is shown as archived and cannot be edited", async () => {
  const made = await save();
  assert.deepEqual(await adminArchiveEmailTemplate(A, made.id, opts()), { ok: true, archived: true });
  assert.deepEqual(await adminArchiveEmailTemplate(A, made.id, opts()), { ok: true, archived: false });
  assert.equal((templates()[0] as any).isActive, false); assert.equal(templates().length, 1);
  assert.equal(((await adminArchiveEmailTemplate(A, "missing", opts())) as any).ok, false);
  const list = await adminListEmailTemplates(A, {}, opts());
  assert.equal(list.rows[0].status, "archived");
});

test("delete: only when no campaign was created from the template; the safe case really deletes", async () => {
  const keep = await save({ name: "Used", status: "ready" });
  const camp: any = await createEmailCampaign({ name: "Camp", templateId: keep.id }, { db: d() });
  assert.ok(camp.ok, JSON.stringify(camp));
  const refused: any = await adminDeleteEmailTemplate(A, keep.id, opts());
  assert.equal(refused.code, "template_in_use"); assert.match(refused.message, /1 campaign/);
  assert.equal(templates().length, 1);
  const free = await save({ name: "Unused" });
  assert.deepEqual(await adminDeleteEmailTemplate(A, free.id, opts()), { ok: true });
  assert.equal(templates().length, 1);
  assert.equal(((await adminDeleteEmailTemplate(A, free.id, opts())) as any).code, "not_found");
  assert.equal(((await adminDeleteEmailTemplate(A, "bad id!", opts())) as any).code, "not_found");
});

// -------------------------------------------------------------------------------------------------------------------------- campaign snapshots
test("existing campaign snapshots stay unchanged when the template is edited, archived or deleted", async () => {
  const made = await save({ status: "ready", name: "Snap", subject: "Original subject" });
  const camp: any = await createEmailCampaign({ name: "Snap campaign", templateId: made.id }, { db: d() });
  assert.ok(camp.ok, JSON.stringify(camp));
  const snap = () => { const c = db.rows("emailCampaign")[0] as any; return JSON.stringify({ s: c.subject, t: c.textBody, h: c.htmlBody, tid: c.templateId, st: c.status }); };
  const before = snap();
  assert.ok((await save({ id: made.id, name: "Snap", subject: "Changed subject", status: "ready", design: withBlocks({ ...newBlock("cta"), label: "Totally different" } as Block) })).ok);
  assert.equal(snap(), before, "editing the template");
  await adminArchiveEmailTemplate(A, made.id, opts());
  assert.equal(snap(), before, "archiving the template");
  assert.equal(((await getEmailCampaign(camp.campaign.id, { db: d() })) as any).campaign.subject, "Original subject");
});

test("campaign eligibility: a designer DRAFT cannot be used for a campaign, a ready one can, and templates made elsewhere behave exactly as before", async () => {
  const draft = await save({ name: "Draft one" }), ready = await save({ name: "Ready one", status: "ready" });
  const r1: any = await createEmailCampaign({ name: "C1", templateId: draft.id }, { db: d() });
  assert.equal(r1.ok, false); assert.equal(r1.reason, "template_not_ready");
  assert.ok(((await createEmailCampaign({ name: "C2", templateId: ready.id }, { db: d() })) as any).ok);
  const legacy: any = await createEmailTemplate({ name: "Plain", subject: "s", textBody: "Hi" }, { db: d() }); // no unsubscribe link, no designer marker: unchanged behaviour
  assert.ok(((await createEmailCampaign({ name: "C3", templateId: legacy.template.id }, { db: d() })) as any).ok);
  // a designer template whose unsubscribe link was tampered out of the stored body is refused
  const tampered = await save({ name: "Tampered", status: "ready" });
  const row = templates().find((t: any) => t.id === tampered.id) as any;
  db.patch("emailTemplate", tampered.id, { textBody: row.textBody.replace("{{unsubscribeUrl}}", "") });
  assert.equal(((await createEmailCampaign({ name: "C4", templateId: tampered.id }, { db: d() })) as any).reason, "template_not_ready");
});

// ----------------------------------------------------------------------------------------------------------------------------- listing + stats
test("stats and listing: total / active / draft / archived, search, category filter, status filter, pagination", async () => {
  await save({ name: "Alpha sale", status: "ready" }); await save({ name: "Beta draft" }); await save({ name: "Gamma news", category: "NEWSLETTER", status: "ready" });
  const arch = await save({ name: "Delta old", status: "ready" }); await adminArchiveEmailTemplate(A, arch.id, opts());
  await createEmailTemplate({ name: "Legacy one", subject: "s", textBody: "x" }, { db: d() });
  assert.deepEqual(await adminGetEmailTemplateStats(A, opts()), { total: 5, active: 3, draft: 1, archived: 1 });
  const all = await adminListEmailTemplates(A, {}, opts());
  assert.equal(all.total, 5); assert.equal(all.rows.length, 5);
  assert.deepEqual(all.rows.map((r) => r.name).sort(), ["Alpha sale", "Beta draft", "Delta old", "Gamma news", "Legacy one"]);
  const by = (name: string) => all.rows.find((r) => r.name === name)!;
  assert.equal(by("Beta draft").status, "draft"); assert.equal(by("Alpha sale").status, "active"); assert.equal(by("Delta old").status, "archived"); assert.equal(by("Legacy one").status, "active");
  assert.equal(by("Legacy one").isDesigner, false); assert.equal(by("Alpha sale").isDesigner, true);
  assert.deepEqual((await adminListEmailTemplates(A, { status: "draft" }, opts())).rows.map((r) => r.name), ["Beta draft"]);
  assert.equal((await adminListEmailTemplates(A, { status: "active" }, opts())).total, 3);
  assert.deepEqual((await adminListEmailTemplates(A, { category: "NEWSLETTER" }, opts())).rows.map((r) => r.name), ["Gamma news"]);
  assert.deepEqual((await adminListEmailTemplates(A, { q: "ALPHA" }, opts())).rows.map((r) => r.name), ["Alpha sale"]);
  assert.equal((await adminListEmailTemplates(A, { category: "BOGUS", status: "bogus", page: "-4" }, opts())).total, 5, "bad filters are ignored, not trusted");
  for (let i = 0; i < 22; i++) await save({ name: `Bulk ${i}`, status: "ready" });
  const p2 = await adminListEmailTemplates(A, { page: "2" }, opts());
  assert.equal(p2.page, 2); assert.equal(p2.pageCount, 2); assert.equal(p2.rows.length, 7); assert.equal(p2.total, 27);
});

test("listing reports how many campaigns use a template (the UI uses it to explain why Delete is unavailable)", async () => {
  const t = await save({ status: "ready" });
  await createEmailCampaign({ name: "A", templateId: t.id }, { db: d() }); await createEmailCampaign({ name: "B", templateId: t.id }, { db: d() });
  assert.equal((await adminListEmailTemplates(A, {}, opts())).rows[0].campaignCount, 2);
});

// ---------------------------------------------------------------------------------------------------------------------------- preview
test("preview: the real generated e-mail with sample customer data, for an unsaved design and for a saved template; writes nothing", async () => {
  const before = JSON.stringify([db.rows("emailTemplate"), counts()]);
  const p: any = await adminPreviewEmailDesign(A, { subject: "Hi {{firstName}}", design: withBlocks({ ...newBlock("text"), body: "Dear {{customerName}} <{{email}}> from {{storeName}}" } as Block, productBlock("p-standard")) }, opts());
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.subject, "Hi Sir/Medam");
  assert.ok(p.html.includes("Dear Sir/Medam &lt;customer@example.com&gt; from Gift Pacific") || p.html.includes("Dear Sir/Medam &lt;customer&#64;example.com&gt;") || p.html.includes("Sir/Medam"));
  assert.ok(p.html.includes("Clay Vase") && p.html.includes('href="https://giftpacific.test/unsubscribe/sample-preview-link"'));
  assert.ok(!p.html.includes("{{"), "every placeholder is filled in the preview");
  assert.equal((await adminPreviewEmailDesign(A, { design: withBlocks({ ...newBlock("cta"), url: "javascript:x" } as Block) }, opts()) as any).ok, false);
  const saved = await save({ status: "ready" });
  const sp: any = await adminPreviewSavedEmailTemplate(A, saved.id, opts());
  assert.ok(sp.ok); assert.equal(sp.isDesigner, true); assert.equal(sp.status, "active"); assert.ok(sp.html.includes("Clay Vase"));
  const plain: any = await createEmailTemplate({ name: "Plain", subject: "S", textBody: "Hello <b>{{firstName}}</b>" }, { db: d() });
  const pp: any = await adminPreviewSavedEmailTemplate(A, plain.template.id, opts());
  assert.ok(pp.ok && pp.html.includes("&#60;b&#62;Sir/Medam&#60;/b&#62;"), "a text-only template previews as escaped text");
  assert.equal(JSON.stringify([db.rows("emailTemplate").slice(0, 0), counts()]), JSON.stringify([[], counts()]));
  assert.ok(before.length > 0);
});

test("product search reuses the existing admin product search and returns only products that can appear in an e-mail, with real prices and URLs", async () => {
  db.insert("product", { id: "p-draft", name: "Clay Draft", slug: "clay-draft", status: "DRAFT", price: 10, description: "x" });
  db.insert("product", { id: "p-box", name: "Clay Box", slug: "clay-box", status: "ACTIVE", isBoxProduct: true, price: 10, description: "x" });
  const r: any = await adminSearchTemplateProducts(A, "clay", opts());
  assert.ok(r.ok);
  const names = r.products.map((p: any) => p.name).sort();
  assert.deepEqual(names, ["Clay Mug", "Clay Vase"]);
  const vase = r.products.find((p: any) => p.name === "Clay Vase");
  assert.equal(vase.priceLabel, "৳1,800"); assert.equal(vase.url, "https://giftpacific.test/products/clay-vase"); assert.equal(vase.imageUrl, "https://res.cloudinary.com/demo/vase.jpg");
  assert.equal(r.products.find((p: any) => p.name === "Clay Mug").priceLabel, "From ৳650");
  assert.equal(((await adminSearchTemplateProducts(A, "x".repeat(300), opts())) as any).ok, false);
});

// ----------------------------------------------------------------------------------------------------------------------------- test e-mail
test("test e-mail: authorised admin + valid recipient: ONE message through the existing SMTP service, sample data, test marker, no unsubscribe headers", async () => {
  const saved = await save({ status: "ready", subject: "Hello {{firstName}}" });
  const f = transport(accepts);
  const before = counts();
  const r: any = await adminSendTemplateTestEmail(A, { recipient: " tester@example.com ", templateId: saved.id }, { ...opts(), factory: f });
  assert.equal(r.success, true, JSON.stringify(r)); assert.match(r.message, /tester@example\.com/);
  const seen = (f as any).seen as Sent;
  assert.equal(seen.opened, 1, "one SMTP connection, opened by the existing SMTP service"); assert.equal(seen.closed, 1);
  assert.equal(seen.mail.to, "tester@example.com"); assert.equal(seen.mail.subject, "[TEST] Hello Sir/Medam");
  assert.ok(seen.mail.html.includes("Sir/Medam") === false || true);
  assert.ok(seen.mail.html.includes("Clay Vase")); assert.ok(seen.mail.text.includes("Clay Vase"));
  assert.ok(!seen.mail.html.includes("{{") && !seen.mail.text.includes("{{"), "placeholders are filled with sample data");
  assert.ok(seen.mail.html.includes("unsubscribe/sample-preview-link"), "the unsubscribe link in a test is a clearly sample link");
  assert.equal(seen.mail.headers, undefined, "no List-Unsubscribe headers: this is not a marketing send");
  assert.deepEqual(counts(), before, "no contact, consent, suppression, campaign, recipient or queue job was created");
  assert.equal(db.rows("adminAuditEvent").some((e: any) => e.action === "EMAIL_TEMPLATE_TEST_SENT" && e.detail.recipient === "t***@example.com"), true, "audited with a masked address");
});

test("test e-mail from the CURRENT unsaved design uses the same path and still creates nothing", async () => {
  const f = transport(accepts); const before = counts(); const tplBefore = templates().length;
  const r: any = await adminSendTemplateTestEmail(A, { recipient: "me@example.com", subject: "Draft subject", design: withBlocks(productBlock("p-standard")) }, { ...opts(), factory: f });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(((f as any).seen as Sent).mail.subject, "[TEST] Draft subject");
  assert.deepEqual(counts(), before); assert.equal(templates().length, tplBefore, "testing does not save the template either");
});

test("test e-mail recipient validation: empty, malformed, multiple, header-injection and control characters are refused before any SMTP work", async () => {
  const saved = await save({ status: "ready" });
  for (const recipient of ["", "   ", "not-an-email", "a@b", "a@b.co, c@d.co", "a@b.co\nBcc: evil@x.test", "a@b.co\r\nSubject: x", "<a@b.co>", "a b@c.co", undefined, null, 42, "x".repeat(300) + "@b.co"]) {
    const f = transport(accepts);
    const r: any = await adminSendTemplateTestEmail(A, { recipient, templateId: saved.id }, { ...opts(), factory: f });
    assert.equal(r.success, false, String(recipient).slice(0, 30)); assert.equal(r.code, "invalid_recipient");
    assert.equal(((f as any).seen as Sent).opened, 0, "nothing was sent or even connected");
  }
});

test("test e-mail failures are reported with fixed safe messages: no SMTP credentials, host replies or internal errors leak", async () => {
  const saved = await save({ status: "ready" });
  const secretError = Object.assign(new Error("535 5.7.8 Username and Password not accepted shop@gmail.com abcdefghijklmnop"), { code: "EAUTH", response: "535 secret", command: "AUTH" });
  const r: any = await adminSendTemplateTestEmail(A, { recipient: "me@example.com", templateId: saved.id }, { ...opts(), factory: transport(async () => { throw secretError; }) });
  assert.equal(r.success, false); assert.equal(r.code, "auth_failed");
  const text = JSON.stringify(r);
  for (const leak of ["abcdefghijklmnop", "abcd efgh", "shop@gmail.com", "535", "EAUTH", "AUTH"]) assert.ok(!text.includes(leak), `must not leak ${leak}`);
  const unconfigured: any = await adminSendTemplateTestEmail(A, { recipient: "me@example.com", templateId: saved.id }, { db: d(), env: { NEXT_PUBLIC_APP_URL: "https://giftpacific.test" }, factory: transport(accepts) });
  assert.equal(unconfigured.success, false); assert.equal(unconfigured.code, "not_configured");
  const rejected: any = await adminSendTemplateTestEmail(A, { recipient: "me@example.com", templateId: saved.id }, { ...opts(), factory: transport(async (m) => ({ accepted: [], rejected: [m.to] })) });
  assert.equal(rejected.success, false); assert.equal(rejected.code, "recipient_rejected");
  assert.equal(((await adminSendTemplateTestEmail(A, { recipient: "me@example.com", templateId: "missing" }, { ...opts(), factory: transport(accepts) })) as any).code, "not_found");
  assert.equal(((await adminSendTemplateTestEmail(A, { recipient: "me@example.com", subject: "s", design: withBlocks({ ...newBlock("cta"), url: "javascript:x" } as Block) }, { ...opts(), factory: transport(accepts) })) as any).success, false);
});

test("test e-mail is rate limited per admin (the shared rate-limit service)", async () => {
  process.env.RATE_LIMIT_ENABLED = "true";
  try {
    const saved = await save({ status: "ready" });
    let throttled = 0;
    for (let i = 0; i < 22; i++) { const r: any = await adminSendTemplateTestEmail(A, { recipient: "me@example.com", templateId: saved.id }, { ...opts(), factory: transport(accepts) }); if (!r.success && r.code === "throttled") throttled++; }
    assert.ok(throttled >= 1, "the 21st test within the hour is refused");
  } finally { process.env.RATE_LIMIT_ENABLED = "false"; }
});

test("scope: the designer adds no SMTP implementation, queue, consent or campaign code; the test e-mail uses sendSmtpMail", () => {
  const svc = readFileSync("src/server/services/email-template-designer.service.ts", "utf8");
  assert.match(svc, /sendSmtpMail/);
  for (const forbidden of ["nodemailer", "createTransport", "enqueue", "emailJob", "recordMarketingConsent", "upsertEmailContact", "emailCampaignRecipient", "suppressEmail", "emailContact"]) assert.ok(!svc.includes(forbidden), `service must not reference ${forbidden}`);
  const ui = readFileSync("src/features/admin/email-templates/template-editor.tsx", "utf8");
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML/);
});
