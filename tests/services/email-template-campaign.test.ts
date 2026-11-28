/* eslint-disable @typescript-eslint/no-explicit-any */
/** Prompt 09: template and campaign management on the in-memory database (real service code; see tests/integration for the PostgreSQL variant). */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { archiveEmailTemplate, createEmailTemplate, getEmailTemplate, listEmailTemplates, updateEmailTemplate } from "@/server/services/email-template.service";
import {
  createEmailCampaign, getEmailCampaign, listEmailCampaigns, transitionEmailCampaignStatus, updateEmailCampaign,
} from "@/server/services/email-campaign.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); });
const NOW = new Date("2026-11-25T10:00:00.000Z");
const FUTURE = "2026-12-05T09:00:00.000Z";

const tpl = (over: Record<string, unknown> = {}) => ({ name: "Winter sale", subject: "Hello {{firstName}}", textBody: "Hi {{customerName}}, see {{storeName}}", ...over });
async function mkTemplate(over: Record<string, unknown> = {}) {
  const r = await createEmailTemplate(tpl(over), { db: db as never });
  assert.ok(r.ok, JSON.stringify(r));
  return r.template;
}
async function mkCampaign(templateId: string, over: Record<string, unknown> = {}) {
  const r = await createEmailCampaign({ name: "Winter campaign", templateId, ...over }, { db: db as never });
  assert.ok(r.ok, JSON.stringify(r));
  return r.campaign;
}
const setCampaign = (id: string, data: Record<string, unknown>) => (db as any).emailCampaign.update({ where: { id }, data });
/** Runs `hook` once, right before the next updateMany on `table`: simulates another request changing the row between this call's read and its guarded write. */
function beforeNextUpdateMany(table: string, hook: () => Promise<unknown>) {
  const orig = (db as any).delegate.bind(db);
  let fired = false;
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t !== table) return d;
    const um = d.updateMany.bind(d);
    d.updateMany = async (a: any) => { if (!fired) { fired = true; await hook(); } return um(a); };
    return d;
  };
}
const failReason = (r: any) => (r.ok ? "ok" : r.reason);

// ----------------------------------------------------------------------------------------------------------------------------------- templates

test("create: stores a normalised active template, reports its variables, and records the actor", async () => {
  const r = await createEmailTemplate(tpl({ name: "  Winter   sale  ", htmlBody: "<p>{{email}}</p>" }), { db: db as never, actorId: "adm" });
  assert.ok(r.ok);
  assert.equal(r.template.name, "Winter sale");
  assert.equal(r.template.category, "MARKETING");
  assert.equal(r.template.isActive, true);
  assert.deepEqual(r.template.variables, ["customerName", "email", "firstName", "storeName"]);
  assert.equal(db.rows("emailTemplate")[0].createdById, "adm");
  assert.ok(!("createdById" in r.template), "the actor id is not part of the view");
});

test("create: validation errors are clear, name the field, and nothing is saved", async () => {
  const bad: [unknown, string, string][] = [
    [null, "input", "invalid_type"], [[], "input", "invalid_type"],
    [tpl({ name: "" }), "name", "required"], [tpl({ name: "n".repeat(121) }), "name", "too_long"], [tpl({ name: "a\nb" }), "name", "control_characters"],
    [tpl({ category: "SPAM" }), "category", "invalid_category"], [tpl({ subject: "" }), "subject", "required"], [tpl({ subject: "a\r\nBcc: x" }), "subject", "control_characters"],
    [tpl({ textBody: " " }), "textBody", "required"], [tpl({ htmlBody: "<script>1</script>" }), "htmlBody", "unsafe_html"],
    [tpl({ isActive: false }), "isActive", "unsupported_field"], [tpl({ id: "x" }), "id", "unsupported_field"], [tpl({ createdById: "x" }), "createdById", "unsupported_field"],
  ];
  for (const [input, field, code] of bad) {
    const r: any = await createEmailTemplate(input, { db: db as never });
    assert.equal(r.reason, "invalid_input", JSON.stringify(input)?.slice(0, 50));
    assert.ok(r.errors.some((e: any) => e.field === field && e.code === code), `${field}/${code}: ${JSON.stringify(r.errors)}`);
    assert.equal(typeof r.message, "string");
  }
  assert.equal(db.rows("emailTemplate").length, 0);
});

test("invalid and unsupported variables are refused on create and update, with the offending name in the message", async () => {
  for (const [field, value] of [["subject", "{{secret}}"], ["textBody", "{{ user.password }}"], ["htmlBody", "<p>{{constructor}}</p>"], ["textBody", "{{{firstName}}}"], ["textBody", "{{#each x}}"]]) {
    const r: any = await createEmailTemplate(tpl({ [field]: value }), { db: db as never });
    assert.equal(r.reason, "invalid_input", `${field}: ${value}`);
    assert.ok(r.errors.some((e: any) => e.field === field));
  }
  const t = await mkTemplate();
  const r: any = await updateEmailTemplate(t.id, { textBody: "Hello {{password}}" }, { db: db as never });
  assert.equal(r.reason, "invalid_input");
  assert.match(r.errors[0].message, /password/);
  assert.equal(db.rows("emailTemplate")[0].textBody, t.textBody, "unchanged");
});

test("duplicate name: refused on create and on rename (exact match after whitespace normalisation)", async () => {
  await mkTemplate({ name: "Alpha" });
  const b = await mkTemplate({ name: "Beta" });
  assert.equal(failReason(await createEmailTemplate(tpl({ name: " Alpha " }), { db: db as never })), "duplicate_name");
  assert.equal(failReason(await updateEmailTemplate(b.id, { name: "Alpha" }, { db: db as never })), "duplicate_name");
  assert.equal(db.rows("emailTemplate").length, 2);
  assert.ok((await createEmailTemplate(tpl({ name: "alpha" }), { db: db as never })).ok, "the schema's unique index is case-sensitive; this follows it");
});

test("update: partial change is validated as a whole, can remove htmlBody, and a no-op reports changed:false", async () => {
  const t = await mkTemplate({ htmlBody: "<p>x</p>" });
  const u: any = await updateEmailTemplate(t.id, { subject: "New subject", htmlBody: null }, { db: db as never });
  assert.ok(u.ok && u.changed);
  assert.equal(u.template.subject, "New subject");
  assert.equal(u.template.htmlBody, null);
  assert.equal(u.template.textBody, t.textBody, "untouched fields stay");
  const again: any = await updateEmailTemplate(t.id, { subject: "New subject" }, { db: db as never });
  assert.ok(again.ok && !again.changed);
  assert.equal(failReason(await updateEmailTemplate(t.id, {}, { db: db as never })), "invalid_input");
  assert.equal(failReason(await updateEmailTemplate(t.id, { isActive: false }, { db: db as never })), "invalid_input", "archiving is not an edit");
  assert.equal(failReason(await updateEmailTemplate("nope", { name: "x" }, { db: db as never })), "not_found");
  assert.equal(failReason(await updateEmailTemplate("a b", { name: "x" }, { db: db as never })), "not_found");
  assert.equal(failReason(await updateEmailTemplate(t.id, { category: "BAD" }, { db: db as never })), "invalid_input");
});

test("archive: sets isActive=false, is idempotent, keeps the row, blocks edits, and never touches campaigns that reference the template", async () => {
  const t = await mkTemplate();
  const c = await mkCampaign(t.id);
  const before = JSON.stringify(db.rows("emailCampaign"));
  assert.deepEqual(await archiveEmailTemplate(t.id, { db: db as never }), { ok: true, archived: true });
  assert.deepEqual(await archiveEmailTemplate(t.id, { db: db as never }), { ok: true, archived: false });
  assert.equal(failReason(await archiveEmailTemplate("missing", { db: db as never })), "not_found");
  assert.equal(db.rows("emailTemplate").length, 1);
  assert.equal(db.rows("emailTemplate")[0].isActive, false);
  assert.equal(failReason(await updateEmailTemplate(t.id, { subject: "x" }, { db: db as never })), "template_archived");
  assert.equal(JSON.stringify(db.rows("emailCampaign")), before, "campaign row is byte-for-byte unchanged");
  assert.equal(db.rows("emailCampaign")[0].templateId, t.id);
  assert.equal((await getEmailCampaign(c.id, { db: db as never }) as any).campaign.subject, c.subject);
});

test("updating a template leaves existing campaigns (their snapshot and reference) unchanged", async () => {
  const t = await mkTemplate();
  const c = await mkCampaign(t.id);
  await updateEmailTemplate(t.id, { subject: "Changed", textBody: "Changed body" }, { db: db as never });
  const row = db.rows("emailCampaign")[0];
  assert.equal(row.subject, c.subject);
  assert.equal(row.textBody, t.textBody);
  assert.equal(row.templateId, t.id);
});

test("get and list: not found, filters, search, newest first, pagination, no bodies in the list", async () => {
  assert.equal(failReason(await getEmailTemplate("zzz", { db: db as never })), "not_found");
  for (let i = 1; i <= 5; i++) await mkTemplate({ name: `Tpl ${i}`, category: i % 2 ? "MARKETING" : "NEWSLETTER" });
  await archiveEmailTemplate(db.rows("emailTemplate")[0].id, { db: db as never });
  const all: any = await listEmailTemplates({}, { db: db as never });
  assert.equal(all.total, 5);
  assert.ok(!("textBody" in all.items[0]));
  const p1: any = await listEmailTemplates({ page: 1, pageSize: 2 }, { db: db as never });
  const p3: any = await listEmailTemplates({ page: 3, pageSize: 2 }, { db: db as never });
  assert.deepEqual([p1.items.length, p3.items.length, p1.totalPages], [2, 1, 3]);
  assert.equal(((await listEmailTemplates({ isActive: true }, { db: db as never })) as any).total, 4);
  assert.equal(((await listEmailTemplates({ isActive: false }, { db: db as never })) as any).total, 1);
  assert.equal(((await listEmailTemplates({ category: "NEWSLETTER" }, { db: db as never })) as any).total, 2);
  assert.equal(((await listEmailTemplates({ search: "tpl 3" }, { db: db as never })) as any).total, 1);
  for (const bad of [{ page: 0 }, { pageSize: 500 }, { category: "x" }, { isActive: "yes" }, { search: 5 }]) assert.equal(failReason(await listEmailTemplates(bad as never, { db: db as never })), "invalid_input");
});

// ---------------------------------------------------------------------------------------------------------------------------------- campaigns

test("create: a DRAFT with a snapshot of the template, a subject override, sender details and the actor", async () => {
  const t = await mkTemplate({ htmlBody: "<p>{{firstName}}</p>" });
  const r: any = await createEmailCampaign({ name: " Spring   push ", templateId: t.id, subject: "Override {{firstName}}", senderName: "GiftPacific", senderEmail: "Shop@Example.com", description: "d" }, { db: db as never, actorId: "adm" });
  assert.ok(r.ok);
  const c = r.campaign;
  assert.deepEqual([c.name, c.status, c.subject, c.textBody, c.htmlBody, c.senderEmail, c.recipientCount], ["Spring push", "DRAFT", "Override {{firstName}}", t.textBody, "<p>{{firstName}}</p>", "shop@example.com", 0]);
  assert.equal(db.rows("emailCampaign")[0].createdById, "adm");
  const plain = await mkCampaign(t.id, { name: "No override" });
  assert.equal(plain.subject, t.subject, "without an override the template subject is used");
});

test("create: invalid template references and unusable templates are refused", async () => {
  const t = await mkTemplate();
  const arch = await mkTemplate({ name: "Old" });
  await archiveEmailTemplate(arch.id, { db: db as never });
  const rec = await mkTemplate({ name: "Recovery", category: "RECOVERY" });
  const ok = (extra: Record<string, unknown>) => createEmailCampaign({ name: "C", ...extra }, { db: db as never });
  assert.equal(failReason(await ok({ templateId: "missing" })), "template_not_found");
  assert.equal(failReason(await ok({ templateId: arch.id })), "template_archived");
  assert.equal(failReason(await ok({ templateId: rec.id })), "template_wrong_category");
  assert.equal(failReason(await ok({})), "invalid_input");
  assert.equal(failReason(await ok({ templateId: "a b/c" })), "invalid_input");
  assert.equal(failReason(await ok({ templateId: 42 })), "invalid_input");
  // a stored template whose content no longer validates (written outside the service) is not usable
  await (db as any).emailTemplate.update({ where: { id: t.id }, data: { textBody: "{{ evil }}" } });
  const r: any = await ok({ templateId: t.id });
  assert.equal(r.reason, "template_invalid");
  assert.equal(db.rows("emailCampaign").length, 0);
});

test("create: validates name, subject override, sender fields, and refuses fields that are not settable", async () => {
  const t = await mkTemplate();
  const bad: [Record<string, unknown>, string][] = [
    [{ name: "" }, "name"], [{ name: "n".repeat(161) }, "name"], [{ name: "a\nb" }, "name"], [{ subject: "x".repeat(201) }, "subject"], [{ subject: "a\r\nb" }, "subject"],
    [{ subject: "{{password}}" }, "subject"], [{ senderEmail: "nope" }, "senderEmail"], [{ senderName: "<x@y.com>" }, "senderName"], [{ description: "d".repeat(1001) }, "description"],
    [{ status: "SENDING" }, "status"], [{ recipientCount: 9 }, "recipientCount"], [{ scheduledAt: FUTURE }, "scheduledAt"], [{ createdById: "x" }, "createdById"],
  ];
  for (const [extra, field] of bad) {
    const r: any = await createEmailCampaign({ name: "Valid", templateId: t.id, ...extra }, { db: db as never });
    assert.equal(r.reason, "invalid_input", field);
    assert.ok(r.errors.some((e: any) => e.field === field), `${field}: ${JSON.stringify(r.errors)}`);
  }
  assert.equal(db.rows("emailCampaign").length, 0);
});

test("create: an open campaign with the same name is refused; a finished one does not block reuse", async () => {
  const t = await mkTemplate();
  const first = await mkCampaign(t.id, { name: "Monthly" });
  assert.equal(failReason(await createEmailCampaign({ name: " Monthly ", templateId: t.id }, { db: db as never })), "duplicate_campaign");
  await transitionEmailCampaignStatus(first.id, "CANCELLED", { db: db as never, now: NOW });
  assert.ok((await createEmailCampaign({ name: "Monthly", templateId: t.id }, { db: db as never })).ok);
  assert.equal(db.rows("emailCampaign").length, 2);
});

test("create: concurrent identical requests produce exactly one campaign", async () => {
  const t = await mkTemplate();
  const results = await Promise.all(Array.from({ length: 5 }, () => createEmailCampaign({ name: "Race", templateId: t.id }, { db: db as never })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(results.filter((r) => !r.ok).map(failReason), Array(4).fill("duplicate_campaign"));
  assert.equal(db.rows("emailCampaign").length, 1);
});

test("update: edits a draft; a template change re-snapshots; subject null/blank restores the template subject", async () => {
  const t1 = await mkTemplate({ name: "T1" });
  const t2 = await mkTemplate({ name: "T2", subject: "Second", textBody: "Second body" });
  const c = await mkCampaign(t1.id, { subject: "Custom" });
  let u: any = await updateEmailCampaign(c.id, { name: "Renamed", description: "desc", senderName: "Team", senderEmail: "a@b.com" }, { db: db as never });
  assert.ok(u.ok && u.changed);
  assert.deepEqual([u.campaign.name, u.campaign.description, u.campaign.senderName, u.campaign.senderEmail, u.campaign.subject], ["Renamed", "desc", "Team", "a@b.com", "Custom"]);
  u = await updateEmailCampaign(c.id, { subject: null }, { db: db as never });
  assert.equal(u.campaign.subject, t1.subject);
  u = await updateEmailCampaign(c.id, { templateId: t2.id }, { db: db as never });
  assert.deepEqual([u.campaign.templateId, u.campaign.subject, u.campaign.textBody], [t2.id, "Second", "Second body"]);
  u = await updateEmailCampaign(c.id, { templateId: t1.id, subject: "Both" }, { db: db as never });
  assert.deepEqual([u.campaign.templateId, u.campaign.subject, u.campaign.textBody], [t1.id, "Both", t1.textBody]);
  u = await updateEmailCampaign(c.id, { name: "Renamed" }, { db: db as never });
  assert.ok(u.ok && !u.changed);
});

test("update: invalid input, bad template, duplicate name and immutable fields are refused without changing the campaign", async () => {
  const t = await mkTemplate();
  const arch = await mkTemplate({ name: "Arch" });
  await archiveEmailTemplate(arch.id, { db: db as never });
  const a = await mkCampaign(t.id, { name: "A" });
  await mkCampaign(t.id, { name: "B" });
  const before = JSON.stringify(db.rows("emailCampaign"));
  const up = (patch: unknown, id: unknown = a.id) => updateEmailCampaign(id, patch, { db: db as never });
  assert.equal(failReason(await up({ name: "B" })), "duplicate_campaign");
  assert.equal(failReason(await up({ templateId: arch.id })), "template_archived");
  assert.equal(failReason(await up({ templateId: "ghost" })), "template_not_found");
  assert.equal(failReason(await up({ subject: "{{x}}" })), "invalid_input");
  assert.equal(failReason(await up({ status: "SENT" })), "invalid_input");
  assert.equal(failReason(await up({ recipientCount: 5 })), "invalid_input");
  assert.equal(failReason(await up({})), "invalid_input");
  assert.equal(failReason(await up(null)), "invalid_input");
  assert.equal(failReason(await up({ name: "x" }, "missing")), "not_found");
  assert.equal(JSON.stringify(db.rows("emailCampaign")), before);
});

test("update: refused for every status other than DRAFT, and a campaign scheduled mid-update is not overwritten", async () => {
  const t = await mkTemplate();
  for (const status of ["SCHEDULED", "SENDING", "COMPLETED", "CANCELLED", "FAILED"]) {
    const row = db.insert("emailCampaign", { name: `S-${status}`, status, subject: "s", textBody: "b", templateId: t.id, recipientCount: 1, scheduledAt: status === "SCHEDULED" ? new Date(FUTURE) : null, completedAt: status === "COMPLETED" ? NOW : null });
    const r: any = await updateEmailCampaign(row.id, { description: "nope" }, { db: db as never });
    assert.equal(r.reason, "not_editable", status);
    assert.equal(db.rows("emailCampaign").find((x) => x.id === row.id)!.description, null);
  }
  // the status changes after the read but before the guarded write
  const c = await mkCampaign(t.id, { name: "Racy" });
  beforeNextUpdateMany("emailCampaign", () => setCampaign(c.id, { status: "CANCELLED" }));
  assert.equal(failReason(await updateEmailCampaign(c.id, { description: "late" }, { db: db as never })), "not_editable");
  assert.equal(db.rows("emailCampaign").find((x) => x.id === c.id)!.description, null);
});

test("get and list: pagination, status/template/name filters, newest first, summaries carry no bodies", async () => {
  assert.equal(failReason(await getEmailCampaign("nope", { db: db as never })), "not_found");
  const t = await mkTemplate();
  const t2 = await mkTemplate({ name: "Other" });
  for (let i = 1; i <= 5; i++) await mkCampaign(i === 5 ? t2.id : t.id, { name: `Camp ${i}` });
  await transitionEmailCampaignStatus(db.rows("emailCampaign")[0].id, "CANCELLED", { db: db as never, now: NOW });
  const list = (q: any) => listEmailCampaigns(q, { db: db as never }) as Promise<any>;
  const all = await list({});
  assert.equal(all.total, 5);
  assert.deepEqual(Object.keys(all.items[0]).filter((k) => ["textBody", "htmlBody", "senderEmail", "senderName"].includes(k)), []);
  assert.deepEqual([(await list({ pageSize: 2, page: 3 })).items.length, (await list({ pageSize: 2 })).totalPages], [1, 3]);
  assert.equal((await list({ status: "CANCELLED" })).total, 1);
  assert.equal((await list({ status: "DRAFT" })).total, 4);
  assert.equal((await list({ templateId: t2.id })).total, 1);
  assert.equal((await list({ search: "camp 2" })).total, 1);
  for (const bad of [{ status: "SENT" }, { templateId: "a b" }, { page: -1 }, { search: "x\ny" }]) assert.equal(failReason(await list(bad)), "invalid_input");
});

// ---------------------------------------------------------------------------------------------------------------------------------- transitions

// Prompt 12: scheduling also needs the P11 unsubscribe prerequisites and real PENDING recipient rows, so the helpers below provide them. Only the setup
// changed; every assertion of these P09 tests is as it was.
const UNSUB_ENV = { EMAIL_UNSUBSCRIBE_SECRET: "test-only-unsubscribe-secret-Zq8Lm3Vx7Rb2Nc5Kd9Wp4Ty6", NEXT_PUBLIC_APP_URL: "https://shop.example.com" };
const tr = (id: string, to: unknown, extra: Record<string, unknown> = {}) => transitionEmailCampaignStatus(id, to, { db: db as never, now: NOW, unsubscribeEnv: UNSUB_ENV, ...extra });
async function withAudience(c: { id: string }) {
  await setCampaign(c.id, { recipientCount: 3, textBody: "Hi {{customerName}}, see {{storeName}}. Unsubscribe: {{unsubscribeUrl}}" });
  db.insert("emailCampaignRecipient", { campaignId: c.id, contactId: `contact-${c.id}`, status: "PENDING" });
}

test("status transitions: DRAFT -> SCHEDULED needs a future time and a prepared audience; SCHEDULED -> DRAFT clears the time; cancel stamps cancelledAt", async () => {
  const t = await mkTemplate();
  const c = await mkCampaign(t.id);
  assert.equal(failReason(await tr(c.id, "SCHEDULED", { scheduledAt: FUTURE })), "no_recipients");
  await withAudience(c);
  assert.equal(failReason(await tr(c.id, "SCHEDULED")), "invalid_input");
  assert.equal(failReason(await tr(c.id, "SCHEDULED", { scheduledAt: "2026-11-01T00:00:00Z" })), "invalid_input");
  assert.equal(db.rows("emailCampaign")[0].status, "DRAFT");
  const s: any = await tr(c.id, "SCHEDULED", { scheduledAt: FUTURE });
  assert.ok(s.ok);
  assert.equal(s.campaign.status, "SCHEDULED");
  assert.equal(s.campaign.scheduledAt.toISOString(), FUTURE);
  const d: any = await tr(c.id, "DRAFT");
  assert.deepEqual([d.campaign.status, d.campaign.scheduledAt], ["DRAFT", null]);
  const x: any = await tr(c.id, "CANCELLED");
  assert.deepEqual([x.campaign.status, x.campaign.cancelledAt.toISOString()], ["CANCELLED", NOW.toISOString()]);
});

test("status transitions: invalid moves, final statuses, sender-only statuses and unknown values are refused", async () => {
  const t = await mkTemplate();
  const c = await mkCampaign(t.id);
  for (const to of ["SENDING", "COMPLETED", "FAILED", "DRAFT"]) assert.equal(failReason(await tr(c.id, to)), "invalid_transition", `DRAFT -> ${to}`);
  assert.equal(failReason(await tr(c.id, "PAUSED")), "invalid_input");
  assert.equal(failReason(await tr(c.id, undefined)), "invalid_input");
  assert.equal(failReason(await tr("missing", "CANCELLED")), "not_found");

  await withAudience(c);
  await tr(c.id, "SCHEDULED", { scheduledAt: FUTURE });
  assert.equal(failReason(await tr(c.id, "SENDING")), "transition_reserved", "valid in the lifecycle, but it is the sender's move");
  assert.equal(failReason(await tr(c.id, "COMPLETED")), "invalid_transition");
  assert.equal(db.rows("emailCampaign")[0].status, "SCHEDULED");

  await tr(c.id, "CANCELLED");
  for (const to of ["DRAFT", "SCHEDULED", "SENDING", "COMPLETED", "FAILED", "CANCELLED"]) assert.equal(failReason(await tr(c.id, to, { scheduledAt: FUTURE })), "invalid_transition", `CANCELLED -> ${to}`);
  for (const status of ["COMPLETED", "FAILED"]) {
    const row = db.insert("emailCampaign", { name: status, status, subject: "s", textBody: "b", completedAt: NOW });
    assert.equal(failReason(await tr(row.id, "DRAFT")), "invalid_transition", status);
  }
  const sending = db.insert("emailCampaign", { name: "Sending", status: "SENDING", subject: "s", textBody: "b", startedAt: NOW });
  assert.equal(failReason(await tr(sending.id, "COMPLETED")), "transition_reserved");
  assert.equal(failReason(await tr(sending.id, "DRAFT")), "invalid_transition");
});

test("status transitions: a concurrent change makes the second writer fail instead of overwriting; scheduling re-validates the snapshot", async () => {
  const t = await mkTemplate();
  const c = await mkCampaign(t.id);
  await withAudience(c);
  beforeNextUpdateMany("emailCampaign", () => setCampaign(c.id, { status: "CANCELLED" }));
  assert.equal(failReason(await tr(c.id, "SCHEDULED", { scheduledAt: FUTURE })), "status_conflict");
  assert.equal(db.rows("emailCampaign")[0].status, "CANCELLED");

  const c2 = await mkCampaign(t.id, { name: "Bad snapshot" });
  await setCampaign(c2.id, { recipientCount: 1, textBody: "{{notAllowed}}" });
  delete (db as any).delegate; // the one-shot hook has already fired; restore the normal delegate
  assert.equal(failReason(await tr(c2.id, "SCHEDULED", { scheduledAt: FUTURE })), "template_invalid");
});

test("nothing in campaign management sends, queues or creates recipients", async () => {
  const t = await mkTemplate();
  const c = await mkCampaign(t.id);
  await withAudience(c);
  const recipientsBefore = db.rows("emailCampaignRecipient").length;
  await tr(c.id, "SCHEDULED", { scheduledAt: FUTURE });
  assert.equal(db.rows("emailJob").length, 0);
  assert.equal(db.rows("emailCampaignRecipient").length, recipientsBefore, "scheduling creates no recipient rows");
});
