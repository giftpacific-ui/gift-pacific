/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * P12-UI-03: Email marketing > Campaigns (list, wizard, review, scheduling, details) on the in-memory database. The REAL existing template, campaign,
 * audience, eligibility, scheduler, dispatch, queue-worker and SMTP code runs underneath; this file only drives them through the new admin layer.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discardAfter, freshDb, runAs, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { captureLogs, makeSmtp, NOW, optedIn, SMTP_ENV, T0, T1, UNSUB_BASE, UNSUB_SECRET } from "../setup/campaign-dispatch-fixture";
import { defaultDesign, newBlock, type Block, type Design } from "@/lib/email-template-blocks";
import { adminSaveEmailTemplate } from "@/server/services/email-template-designer.service";
import { createEmailTemplate } from "@/server/services/email-template.service";
import { suppressEmail } from "@/server/services/email-suppression.service";
import { dispatchDueCampaigns } from "@/server/services/email-campaign-scheduler.service";
import { processEmailQueue } from "@/server/services/email-queue.service";
import { audienceAdditiveWarning, campaignActionsFor, CAMPAIGN_STATUS_LABEL, reasonLabel } from "@/lib/email-campaigns";
import { CAMPAIGN_STATUSES } from "@/lib/email/campaign-rules";
import {
  adminCancelCampaign, adminGetAudienceOverview, adminGetCampaignDetail, adminGetCampaignDraftForWizard, adminGetCampaignReview, adminGetCampaignStats, adminListCampaignTemplates,
  adminListCampaigns, adminPrepareCampaignAudience, adminSaveCampaignDraft, adminScheduleCampaign, adminSearchAudienceContacts, adminSendCampaignNow, adminUnscheduleCampaign,
} from "@/server/services/admin-email-campaign.service";
import {
  cancelCampaignAction, getCampaignAudienceOverviewAction, getCampaignReviewAction, previewCampaignTemplateAction, prepareCampaignAudienceAction, saveCampaignDraftAction,
  searchAudienceContactsAction, sendCampaignNowAction, unscheduleCampaignAction,
} from "@/server/actions/admin-email-campaign.actions";

let db: FakeDb;
let smtp: ReturnType<typeof makeSmtp>;
let logs: ReturnType<typeof captureLogs>;
const SAVED_ENV: Record<string, string | undefined> = {};
beforeEach(() => {
  SAVED_ENV.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED;
  process.env.RATE_LIMIT_ENABLED = "false";
  db = freshDb(); smtp = makeSmtp(); discardAfter(); seedAdmins(db);
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer Nine", role: "CUSTOMER", isActive: true });
  db.insert("user", { id: "adm-off", email: "off@staff.test", name: "Deactivated", role: "ADMIN", isActive: false });
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  if (SAVED_ENV.RATE_LIMIT_ENABLED === undefined) delete process.env.RATE_LIMIT_ENABLED; else process.env.RATE_LIMIT_ENABLED = SAVED_ENV.RATE_LIMIT_ENABLED;
});

const A = "admin-1";
const D = () => db as never;
const GOOD_ENV = { EMAIL_UNSUBSCRIBE_SECRET: UNSUB_SECRET, NEXT_PUBLIC_APP_URL: UNSUB_BASE };
const DESIGN_ENV = { NEXT_PUBLIC_APP_URL: "https://giftpacific.test", NODE_ENV: "test", ...SMTP_ENV, SMTP_FROM_NAME: "GiftPacific", SMTP_FROM_EMAIL: "" };
const campaigns = () => db.rows("emailCampaign") as any[];
const recipients = (id?: string) => (db.rows("emailCampaignRecipient") as any[]).filter((r) => !id || r.campaignId === id);
const jobs = () => db.rows("emailJob") as any[];
const counts = () => ({ contacts: db.rows("emailContact").length, consents: db.rows("marketingConsent").length, suppressions: db.rows("emailSuppression").length, jobs: jobs().length });
const future = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();

const textBlock = (body: string): Block => ({ ...newBlock("text"), heading: "Weekend offer", body }) as Block;
const design = (): Design => { const x = defaultDesign(); return { preheader: "Sneak peek", blocks: [x.blocks[0], textBlock("Dear {{customerName}}, enjoy **20% off** at {{storeName}}. [Shop now](/shop)"), x.blocks[x.blocks.length - 1]] }; };
async function designerTemplate(status: "draft" | "ready", name = `Designer ${status}`) {
  const r: any = await adminSaveEmailTemplate(A, { name, category: "MARKETING", subject: "Hello {{firstName}}", status, design: design() }, { db: D(), env: DESIGN_ENV });
  assert.ok(r.ok, JSON.stringify(r));
  return r.id as string;
}
async function standardTemplate(over: Record<string, unknown> = {}) {
  const t: any = await createEmailTemplate({ name: "Standard", subject: "Hi {{firstName}}", textBody: "Hello {{customerName}}, welcome to {{storeName}}. Unsubscribe: {{unsubscribeUrl}}", ...over }, { db: D() });
  assert.ok(t.ok, JSON.stringify(t));
  return t.template.id as string;
}
const draft = async (templateId: string, over: Record<string, unknown> = {}) => {
  const r: any = await adminSaveCampaignDraft(A, { name: "Winter campaign", templateId, ...over }, { db: D() });
  assert.ok(r.ok, JSON.stringify(r));
  return r.id as string;
};
const prepare = async (id: string, input: unknown = {}) => { const r: any = await adminPrepareCampaignAudience(A, id, input, { db: D(), now: T0 }); assert.ok(r.ok, JSON.stringify(r)); return r; };
const schedule = (id: string, when = T1.toISOString()) => adminScheduleCampaign(A, id, when, { db: D(), now: T0, unsubscribeEnv: GOOD_ENV }) as Promise<any>;
/** template -> draft -> audience -> SCHEDULED, all through the new admin layer. */
async function scheduled(emails = ["a@example.com", "b@example.com"], templateId?: string) {
  for (const e of emails) await optedIn(db, e);
  const id = await draft(templateId ?? (await standardTemplate()));
  await prepare(id);
  const s = await schedule(id);
  assert.ok(s.ok, JSON.stringify(s));
  return id;
}

// ------------------------------------------------------------------------------------------------------------------------------ authorization

test("authorization: every service operation refuses a customer, a deactivated admin and nobody", async () => {
  const calls: [string, (who: unknown) => Promise<any>][] = [
    ["stats", (w) => adminGetCampaignStats(w, { db: D() })], ["list", (w) => adminListCampaigns(w, {}, { db: D() })], ["templates", (w) => adminListCampaignTemplates(w, { db: D() })],
    ["save", (w) => adminSaveCampaignDraft(w, { name: "x", templateId: "t" }, { db: D() })], ["wizard", (w) => adminGetCampaignDraftForWizard(w, "c", { db: D() })],
    ["overview", (w) => adminGetAudienceOverview(w, "c", { db: D() })], ["prepare", (w) => adminPrepareCampaignAudience(w, "c", {}, { db: D() })],
    ["search", (w) => adminSearchAudienceContacts(w, "a", { db: D() })], ["review", (w) => adminGetCampaignReview(w, "c", { db: D() })],
    ["schedule", (w) => adminScheduleCampaign(w, "c", future(), { db: D() })], ["send now", (w) => adminSendCampaignNow(w, "c", { db: D() })], ["unschedule", (w) => adminUnscheduleCampaign(w, "c", { db: D() })], ["cancel", (w) => adminCancelCampaign(w, "c", { db: D() })],
    ["detail", (w) => adminGetCampaignDetail(w, "c", {}, { db: D() })],
  ];
  const before = counts();
  for (const [name, call] of calls) {
    for (const who of ["cust-9", "adm-off", null, undefined, "nobody"]) {
      const out = await call(who).then((r) => r, (e) => ({ threw: e }));
      const refused = out?.threw instanceof Error ? /not authorised/.test(out.threw.message) : out?.ok === false && out.code === "forbidden";
      assert.ok(refused, `${name} must refuse ${String(who)}: ${JSON.stringify(out?.threw?.message ?? out)}`);
    }
  }
  assert.deepEqual(counts(), before, "refused calls change nothing");
  assert.equal(campaigns().length, 0);
});

test("authorization: every server action refuses a signed-out visitor and a customer before doing anything", async () => {
  const actions: [string, () => Promise<unknown>][] = [
    ["save", () => saveCampaignDraftAction({ name: "x", templateId: "t" })], ["preview", () => previewCampaignTemplateAction("t")], ["overview", () => getCampaignAudienceOverviewAction("c")],
    ["search", () => searchAudienceContactsAction("a")], ["prepare", () => prepareCampaignAudienceAction("c", {})], ["review", () => getCampaignReviewAction("c")],
    ["send now", () => sendCampaignNowAction("c")], ["unschedule", () => unscheduleCampaignAction("c")], ["cancel", () => cancelCampaignAction("c")],
  ];
  for (const [name, call] of actions) {
    await assert.rejects(runAs(null, call as never), /FORBIDDEN/, `${name}: signed out`);
    await assert.rejects(runAs({ sub: "cust-9" }, call as never), /FORBIDDEN/, `${name}: customer`);
  }
  assert.equal(campaigns().length, 0);
});

// ------------------------------------------------------------------------------------------------------------------------------ create + validation

test("creating a draft: DRAFT status, its own snapshot of the template, creator recorded; no recipient, consent, contact or job is created", async () => {
  const tpl = await standardTemplate();
  const before = counts();
  const res: any = await runAs("admin", () => saveCampaignDraftAction({ name: " Winter campaign ", description: "Seasonal", senderName: "Gift Pacific", senderEmail: "Hello@Shop.Example.com", templateId: tpl }) as never);
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.created, true);
  const c = campaigns()[0];
  assert.equal(c.status, "DRAFT"); assert.equal(c.name, "Winter campaign"); assert.equal(c.senderEmail, "hello@shop.example.com"); assert.equal(c.createdById, A);
  assert.equal(c.scheduledAt ?? null, null); assert.equal(c.recipientCount ?? 0, 0);
  assert.ok(c.textBody.includes("{{unsubscribeUrl}}"), "snapshot of the template body");
  assert.deepEqual(counts(), before, "nothing but the campaign row is written");
  assert.equal(recipients().length, 0);
  assert.ok(db.rows("adminAuditEvent").some((a: any) => a.action === "email_campaign.create" && a.entityId === c.id), "audited");
});

test("validation: missing name, bad sender and unsupported fields are refused with field messages and nothing is stored", async () => {
  const tpl = await standardTemplate();
  const bad: [Record<string, unknown>, string][] = [
    [{ name: "   ", templateId: tpl }, "name"], [{ name: "x".repeat(161), templateId: tpl }, "name"], [{ name: "ok", templateId: tpl, senderEmail: "not-an-email" }, "senderEmail"],
    [{ name: "ok", templateId: tpl, senderName: "Evil <x@y.z>" }, "senderName"], [{ name: "ok" }, "templateId"], [{ name: "ok", templateId: "../etc/passwd" }, "templateId"],
  ];
  for (const [input, field] of bad) {
    const r: any = await adminSaveCampaignDraft(A, input, { db: D() });
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.ok(r.errors?.some((e: any) => e.field === field) || r.code === "template_not_found", `${field}: ${JSON.stringify(r)}`);
  }
  assert.equal(campaigns().length, 0);
  for (const nonsense of [null, "text", 5, []]) assert.equal(((await adminSaveCampaignDraft(A, nonsense, { db: D() })) as any).ok, false);
});

test("status, schedule, counts and owner cannot be injected through the draft form", async () => {
  const tpl = await standardTemplate();
  const id = await draft(tpl, { status: "SENDING", scheduledAt: T1.toISOString(), recipientCount: 999, sentCount: 999, createdById: "someone" });
  const c = campaigns().find((x) => x.id === id);
  assert.equal(c.status, "DRAFT"); assert.equal(c.scheduledAt ?? null, null); assert.equal(c.recipientCount ?? 0, 0); assert.equal(c.sentCount ?? 0, 0); assert.equal(c.createdById, A);
  const upd: any = await adminSaveCampaignDraft(A, { campaignId: id, status: "SENT", recipientCount: 5, name: "Renamed" }, { db: D() });
  assert.ok(upd.ok);
  assert.equal(campaigns()[0].status, "DRAFT"); assert.equal(campaigns()[0].recipientCount ?? 0, 0); assert.equal(campaigns()[0].name, "Renamed");
});

// ------------------------------------------------------------------------------------------------------------------------------ templates

test("template selection: ready designer and standard templates are eligible, a draft designer template is listed but blocked, archived and recovery are not offered", async () => {
  const ready = await designerTemplate("ready"), draftT = await designerTemplate("draft"), standard = await standardTemplate({ name: "Plain" });
  const archived = await standardTemplate({ name: "Old" }); db.patch("emailTemplate", archived, { isActive: false });
  const recovery = await standardTemplate({ name: "Recover", category: "RECOVERY" });
  const list = await adminListCampaignTemplates(A, { db: D() });
  const by = new Map(list.map((t) => [t.id, t]));
  assert.equal(by.get(ready)?.eligible, true); assert.equal(by.get(ready)?.kind, "ready"); assert.equal(by.get(ready)?.isDesigner, true);
  assert.equal(by.get(standard)?.eligible, true); assert.equal(by.get(standard)?.kind, "standard");
  assert.equal(by.get(draftT)?.eligible, false); assert.equal(by.get(draftT)?.kind, "draft"); assert.match(by.get(draftT)?.reason ?? "", /draft/i);
  assert.ok(!by.has(archived) && !by.has(recovery), "archived and recovery templates are not offered");
});

test("draft designer templates stay blocked on the server even if the browser sends them; ready designer templates work normally", async () => {
  const draftT = await designerTemplate("draft"), ready = await designerTemplate("ready");
  const blocked: any = await runAs("admin", () => saveCampaignDraftAction({ name: "Blocked", templateId: draftT }) as never);
  assert.equal(blocked.success, false); assert.equal(blocked.code, "template_not_ready"); assert.equal(campaigns().length, 0);
  const ok: any = await runAs("admin", () => saveCampaignDraftAction({ name: "Allowed", templateId: ready }) as never);
  assert.equal(ok.success, true, JSON.stringify(ok));
  // switching an existing draft campaign to a draft template is refused too, and the campaign keeps its previous template
  const swap: any = await adminSaveCampaignDraft(A, { campaignId: ok.id, templateId: draftT }, { db: D() });
  assert.equal(swap.ok, false); assert.equal(swap.code, "template_not_ready");
  assert.equal(campaigns()[0].templateId, ready);
  const missing: any = await adminSaveCampaignDraft(A, { name: "Ghost", templateId: "does-not-exist" }, { db: D() });
  assert.equal(missing.code, "template_not_found");
});

test("the campaign snapshot of a designer template has no internal marker, while the stored template keeps it for editing", async () => {
  const ready = await designerTemplate("ready");
  const id = await draft(ready);
  const c = campaigns().find((x) => x.id === id);
  assert.doesNotMatch(c.htmlBody, /gp-design/);
  assert.match((db.rows("emailTemplate") as any[]).find((t) => t.id === ready).htmlBody, /gp-design:v1:ready:/);
});

test("template preview in the wizard is the existing template preview: customer-facing HTML without the marker", async () => {
  const ready = await designerTemplate("ready");
  const res: any = await runAs("admin", () => previewCampaignTemplateAction(ready) as never);
  assert.equal(res.success, true, JSON.stringify(res));
  assert.doesNotMatch(res.html, /gp-design/); assert.doesNotMatch(res.html, /<!--/); assert.match(res.html, /Weekend offer/);
  const unknown: any = await runAs("admin", () => previewCampaignTemplateAction("nope") as never);
  assert.equal(unknown.success, false);
});

// ------------------------------------------------------------------------------------------------------------------------------ duplicates

test("duplicate submission: two racing creates make ONE campaign; saving again with the campaign id updates it instead of creating another", async () => {
  const tpl = await standardTemplate();
  const [a, b] = (await Promise.all([adminSaveCampaignDraft(A, { name: "Twice", templateId: tpl }, { db: D() }), adminSaveCampaignDraft(A, { name: "Twice", templateId: tpl }, { db: D() })])) as any[];
  assert.equal([a, b].filter((r) => r.ok).length, 1, JSON.stringify([a, b]));
  assert.equal([a, b].find((r) => !r.ok).code, "duplicate_campaign");
  assert.equal(campaigns().length, 1);
  const id = [a, b].find((r) => r.ok).id;
  const again: any = await adminSaveCampaignDraft(A, { campaignId: id, name: "Twice", templateId: tpl, description: "now with text" }, { db: D() });
  assert.ok(again.ok); assert.equal(again.created, false); assert.equal(campaigns().length, 1); assert.equal(campaigns()[0].description, "now with text");
  const sameName: any = await adminSaveCampaignDraft(A, { name: "Twice", templateId: tpl }, { db: D() });
  assert.equal(sameName.code, "duplicate_campaign", "a second NEW campaign with an open name is refused");
});

test("only a draft can be edited from the wizard; a scheduled campaign is refused and unchanged", async () => {
  const id = await scheduled();
  const r: any = await adminSaveCampaignDraft(A, { campaignId: id, name: "Hijack" }, { db: D() });
  assert.equal(r.ok, false); assert.equal(r.code, "not_editable");
  assert.notEqual(campaigns().find((c) => c.id === id).name, "Hijack");
  const w: any = await adminGetCampaignDraftForWizard(A, id, { db: D() });
  assert.equal(w.ok, false); assert.equal(w.code, "not_editable");
});

// ------------------------------------------------------------------------------------------------------------------------------ audience

async function mixedContacts() {
  const ok1 = await optedIn(db, "ok1@example.com"), ok2 = await optedIn(db, "ok2@example.com");
  const unsub = await optedIn(db, "unsub@example.com"); await suppressEmail("unsub@example.com", { reason: "UNSUBSCRIBED" }, { db: D(), now: T0 });
  const bounced = await optedIn(db, "bounce@example.com"); await suppressEmail("bounce@example.com", { reason: "BOUNCED" }, { db: D(), now: T0 });
  const complained = await optedIn(db, "complain@example.com"); await suppressEmail("complain@example.com", { reason: "COMPLAINED" }, { db: D(), now: T0 });
  const admin = await optedIn(db, "blocked@example.com"); await suppressEmail("blocked@example.com", { reason: "ADMIN" }, { db: D(), now: T0 });
  const inactive = await optedIn(db, "inactive@example.com", { isActive: false });
  const noConsent: any = await (db as any).emailContact.create({ data: { email: "noconsent@example.com", name: "No Consent", source: "MANUAL" } });
  // A contact whose ONLY signal is saving checkout progress: that is not marketing consent.
  const checkout: any = await (db as any).emailContact.create({ data: { email: "checkout@example.com", name: "Checkout Only", source: "CUSTOMER" } });
  db.insert("incompleteCheckout", { id: "ic-1", email: "checkout@example.com", consentAt: new Date(T0.getTime() - 3600_000) });
  return { ok1, ok2, unsub, bounced, complained, admin, inactive, noConsent, checkout };
}

test("audience: only eligible contacts are added; unsubscribed, bounced, complained, admin-suppressed, inactive, no-consent and checkout-only contacts never are", async () => {
  const c = await mixedContacts();
  const id = await draft(await standardTemplate());
  const r = await prepare(id);
  const emails = recipients(id).map((x: any) => (db.rows("emailContact") as any[]).find((k) => k.id === x.contactId).email).sort();
  assert.deepEqual(emails, ["ok1@example.com", "ok2@example.com"]);
  assert.equal(r.run.added, 2); assert.equal(r.audience.eligible, 2); assert.equal(r.audience.total, 2);
  assert.ok(r.run.excluded.suppressed >= 4, "unsubscribed, bounced, complained and admin-suppressed are all counted as suppressed");
  assert.ok(r.run.excluded.no_consent >= 2, "no-consent AND checkout-only contacts are excluded for lack of marketing consent");
  assert.ok(!recipients(id).some((x: any) => x.contactId === c.inactive.contact.id), "inactive contacts are not even considered by the existing audience run");
  const ids = new Set(recipients(id).map((x: any) => x.contactId));
  for (const k of ["unsub", "bounced", "complained", "admin", "inactive", "noConsent", "checkout"] as const) {
    const contactId = ((c as any)[k].contact ?? (c as any)[k]).id;
    assert.ok(!ids.has(contactId), `${k} must not be a recipient`);
  }
  assert.equal(campaigns().find((x) => x.id === id).recipientCount, 2, "the stored count comes from the database");
  assert.equal(jobs().length, 0, "preparing an audience queues nothing");
});

test("audience: the browser cannot supply counts or eligibility, and selecting an ineligible contact by id does not add it", async () => {
  const c = await mixedContacts();
  const id = await draft(await standardTemplate());
  const picked = [c.unsub.contact.id, c.bounced.contact.id, c.ok1.contact.id, c.noConsent.id];
  const r = await prepare(id, { contactIds: picked, recipientCount: 5000, eligible: true, eligibleCount: 5000 });
  assert.deepEqual(recipients(id).map((x: any) => x.contactId), [c.ok1.contact.id]);
  assert.equal(r.audience.eligible, 1); assert.equal(r.run.recipientCount, 1);
  for (const bad of [{ contactIds: "all" }, { contactIds: [] }, { contactIds: [123] }, { contactIds: ["../x"] }, { contactIds: Array.from({ length: 501 }, (_, i) => `c${i}`) }]) {
    const x: any = await adminPrepareCampaignAudience(A, id, bad, { db: D(), now: T0 });
    assert.equal(x.ok, false, JSON.stringify(bad).slice(0, 60)); assert.equal(x.code, "invalid_input");
  }
  assert.equal(recipients(id).length, 1);
});

test("audience: re-running re-checks existing recipients (a contact who unsubscribed is skipped) and never creates duplicates", async () => {
  await optedIn(db, "a@example.com"); await optedIn(db, "b@example.com");
  const id = await draft(await standardTemplate());
  await prepare(id);
  await suppressEmail("b@example.com", { reason: "UNSUBSCRIBED" }, { db: D(), now: T0 });
  const r = await prepare(id);
  assert.equal(recipients(id).length, 2, "no duplicate rows");
  assert.equal(r.audience.eligible, 1); assert.equal(r.audience.skipped, 1);
  assert.deepEqual(r.audience.skipReasons, [{ code: "suppressed", count: 1 }]);
  assert.equal(r.run.skippedNow, 1);
});

test("audience: an overview shows the contact pool (unsubscribed / suppressed / inactive counts) from the existing contact statistics", async () => {
  await mixedContacts();
  const id = await draft(await standardTemplate());
  const o: any = await runAs("admin", () => getCampaignAudienceOverviewAction(id) as never);
  assert.equal(o.success, true, JSON.stringify(o));
  assert.equal(o.pool.total, 9); assert.equal(o.pool.unsubscribed, 1); assert.equal(o.pool.suppressed, 3); assert.equal(o.pool.inactive, 1); assert.equal(o.pool.eligible, 2);
  assert.equal(o.audience.total, 0);
  const missing: any = await runAs("admin", () => getCampaignAudienceOverviewAction("nope") as never);
  assert.equal(missing.success, false);
});

test("audience: the contact picker lists only consenting candidates and still reports each one's eligibility verdict", async () => {
  await mixedContacts();
  const r: any = await runAs("admin", () => searchAudienceContactsAction("example.com") as never);
  assert.equal(r.success, true);
  const emails = r.contacts.map((c: any) => c.email);
  assert.ok(emails.includes("ok1@example.com")); assert.ok(!emails.includes("noconsent@example.com")); assert.ok(!emails.includes("unsub@example.com"));
  assert.ok(r.contacts.every((c: any) => typeof c.eligible === "boolean"));
});

test("audience: a campaign that is no longer a draft cannot have its audience changed", async () => {
  const id = await scheduled(["a@example.com"]);
  await optedIn(db, "late@example.com");
  const r: any = await adminPrepareCampaignAudience(A, id, {}, { db: D(), now: T0 });
  assert.equal(r.ok, false); assert.equal(r.code, "not_editable");
  assert.equal(recipients(id).length, 1);
});

// ------------------------------------------------------------------------------------------------------------------------------ review

test("review: a ready designer campaign previews the customer-facing message (no marker, sample unsubscribe link, valid) and passes every check", async () => {
  await optedIn(db, "a@example.com");
  const id = await draft(await designerTemplate("ready"));
  await prepare(id);
  const res: any = await runAs("admin", () => getCampaignReviewAction(id) as never);
  assert.equal(res.success, true, JSON.stringify(res));
  const r = res.review;
  assert.equal(r.ready, true, JSON.stringify(r.checks.filter((k: any) => !k.ok)));
  assert.doesNotMatch(r.html, /gp-design/i); assert.doesNotMatch(r.html, /<!--/); assert.doesNotMatch(r.text, /gp-design/i); assert.doesNotMatch(r.subject, /gp-design/i);
  assert.match(r.html, /Weekend offer/); assert.match(r.html, /Ayesha/); assert.doesNotMatch(r.html, /\{\{/, "every placeholder is filled");
  assert.match(r.html, /\/unsubscribe\/sample-preview-link/, "a SAMPLE link is shown, never a real token");
  assert.equal(r.audience.eligible, 1);
  assert.equal(r.checks.find((k: any) => k.id === "unsubscribe_link").ok, true);
  assert.equal(r.checks.find((k: any) => k.id === "no_internal_marker").ok, true);
  assert.equal(r.campaign.templateName, "Designer ready");
  const dump = JSON.stringify(res);
  assert.ok(!dump.includes(UNSUB_SECRET), "no secret in the review");
});

test("review: a snapshot that still carries the marker is previewed without it", async () => {
  await optedIn(db, "a@example.com");
  const id = await draft(await standardTemplate({ htmlBody: "<p>Hello {{firstName}} <a href=\"{{unsubscribeUrl}}\">Unsubscribe</a></p>" }));
  const c = campaigns().find((x) => x.id === id);
  db.patch("emailCampaign", id, { htmlBody: `${c.htmlBody}\n<!--gp-design:v1:ready:abcdef-->` });
  await prepare(id);
  const r: any = await adminGetCampaignReview(A, id, { db: D(), env: GOOD_ENV });
  assert.ok(r.ok); assert.doesNotMatch(r.review.html, /gp-design/); assert.equal(r.review.ready, true);
});

test("review: no audience, no unsubscribe link and a missing unsubscribe secret each block readiness with a clear message", async () => {
  const noAudience: any = await adminGetCampaignReview(A, await draft(await standardTemplate()), { db: D(), env: GOOD_ENV });
  assert.equal(noAudience.review.ready, false); assert.equal(noAudience.review.checks.find((k: any) => k.id === "audience").ok, false);

  await optedIn(db, "a@example.com");
  const noLink = await draft(await standardTemplate({ name: "No link", textBody: "Hello {{customerName}} no link here" }), { name: "No link campaign" });
  await prepare(noLink);
  const l: any = await adminGetCampaignReview(A, noLink, { db: D(), env: GOOD_ENV });
  const linkCheck = l.review.checks.find((k: any) => k.id === "unsubscribe_link");
  assert.equal(linkCheck.ok, false); assert.match(linkCheck.detail, /unsubscribeUrl/); assert.equal(l.review.ready, false);

  const fine = await draft(await standardTemplate({ name: "Fine" }), { name: "Fine campaign" });
  await prepare(fine);
  const noSecret: any = await adminGetCampaignReview(A, fine, { db: D(), env: { NEXT_PUBLIC_APP_URL: UNSUB_BASE } });
  const setup = noSecret.review.checks.find((k: any) => k.id === "unsubscribe_setup");
  assert.equal(setup.ok, false); assert.match(setup.detail, /EMAIL_UNSUBSCRIBE_SECRET/); assert.equal(noSecret.review.ready, false);
  assert.ok(!JSON.stringify(noSecret).includes(UNSUB_SECRET));
});

// ------------------------------------------------------------------------------------------------------------------------------ scheduling

test("scheduling validation: past, malformed and too-far dates are refused with a message and the campaign stays a draft with no time", async () => {
  await optedIn(db, "a@example.com");
  const id = await draft(await standardTemplate());
  await prepare(id);
  const cases: [unknown, RegExp][] = [
    [new Date(T0.getTime() - 1000).toISOString(), /future/], [T0.toISOString(), /future/], ["tomorrow", /valid date/], ["", /valid date/], [null, /valid date/], [12345, /valid date/],
    [new Date(T0.getTime() + 400 * 86_400_000).toISOString(), /within one year/],
  ];
  for (const [when, msg] of cases) {
    const r: any = await adminScheduleCampaign(A, id, when, { db: D(), now: T0, unsubscribeEnv: GOOD_ENV });
    assert.equal(r.ok, false, String(when)); assert.match(r.message, msg, String(when));
  }
  const c = campaigns().find((x) => x.id === id);
  assert.equal(c.status, "DRAFT"); assert.equal(c.scheduledAt ?? null, null);
});

test("scheduling: a draft without an audience, or without the unsubscribe prerequisites, is refused and stays a draft", async () => {
  const id = await draft(await standardTemplate());
  const none: any = await schedule(id);
  assert.equal(none.ok, false); assert.equal(none.code, "no_recipients");
  await optedIn(db, "a@example.com"); await prepare(id);
  const noSecret: any = await adminScheduleCampaign(A, id, T1.toISOString(), { db: D(), now: T0, unsubscribeEnv: { NEXT_PUBLIC_APP_URL: UNSUB_BASE } });
  assert.equal(noSecret.ok, false); assert.equal(noSecret.code, "unsubscribe_link_unavailable");
  assert.equal(campaigns().find((c) => c.id === id).status, "DRAFT");
});

test("scheduling: a valid draft becomes SCHEDULED with its time and queues nothing (the scheduler sends it later); a repeat is an invalid transition", async () => {
  await optedIn(db, "a@example.com");
  const id = await draft(await standardTemplate());
  await prepare(id);
  const before = counts();
  const r: any = await schedule(id);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.status, "SCHEDULED"); assert.equal(r.scheduledAt, T1.toISOString());
  const c = campaigns().find((x) => x.id === id);
  assert.equal(c.status, "SCHEDULED"); assert.equal(new Date(c.scheduledAt).toISOString(), T1.toISOString());
  assert.deepEqual(counts(), { ...before, jobs: 0 }, "no EmailJob, contact, consent or suppression is created");
  assert.equal(smtp.mails.length, 0, "nothing is sent");
  assert.ok(db.rows("adminAuditEvent").some((a: any) => a.action === "email_campaign.schedule" && a.entityId === id));
  const again: any = await schedule(id);
  assert.equal(again.ok, false); assert.equal(again.code, "invalid_transition");
});

test("the browser can no longer schedule: there is no scheduling server action, and the send-now action accepts no time", async () => {
  const actions: Record<string, unknown> = await import("@/server/actions/admin-email-campaign.actions");
  assert.equal(actions.scheduleCampaignAction, undefined);
  assert.equal(sendCampaignNowAction.length, 1, "only the campaign id is read from the browser");
});

// ------------------------------------------------------------------------------------------------------------------------------ transitions

test("transitions: unschedule returns to draft and clears the time; cancel works from draft and scheduled; finished campaigns cannot change", async () => {
  const id = await scheduled(["a@example.com"]);
  const un: any = await adminUnscheduleCampaign(A, id, { db: D(), now: T0 });
  assert.equal(un.ok, true); assert.equal(un.status, "DRAFT"); assert.equal(un.scheduledAt, null);
  assert.equal(campaigns()[0].scheduledAt ?? null, null);
  const notScheduled: any = await adminUnscheduleCampaign(A, id, { db: D() });
  assert.equal(notScheduled.ok, false); assert.equal(notScheduled.code, "invalid_transition");

  const c1: any = await adminCancelCampaign(A, id, { db: D(), now: T0 });
  assert.equal(c1.ok, true); assert.equal(c1.status, "CANCELLED"); assert.ok(campaigns()[0].cancelledAt);
  for (const f of [() => adminCancelCampaign(A, id, { db: D() }), () => adminUnscheduleCampaign(A, id, { db: D() }), () => schedule(id)]) {
    const r: any = await f(); assert.equal(r.ok, false); assert.equal(r.code, "invalid_transition");
  }
  for (const status of ["COMPLETED", "FAILED"]) {
    db.patch("emailCampaign", id, { status });
    const r: any = await adminCancelCampaign(A, id, { db: D() });
    assert.equal(r.ok, false, status); assert.equal(r.code, "invalid_transition");
  }
});

test("transitions: SENDING can be cancelled (existing rule) but cannot be scheduled or unscheduled; the UI offers exactly what the rules allow", async () => {
  const id = await scheduled(["a@example.com"]);
  db.patch("emailCampaign", id, { status: "SENDING" });
  for (const f of [() => schedule(id), () => adminUnscheduleCampaign(A, id, { db: D() })]) { const r: any = await f(); assert.equal(r.ok, false); assert.equal(r.code, "invalid_transition"); }
  const c: any = await adminCancelCampaign(A, id, { db: D(), now: T0 });
  assert.equal(c.ok, true); assert.equal(c.status, "CANCELLED");
});

test("actions per status come from the lifecycle: draft edits/sends/cancels, a legacy scheduled campaign unschedules/cancels, sending only cancels, final states offer nothing", () => {
  assert.deepEqual(campaignActionsFor("DRAFT"), ["edit_draft", "send_now", "cancel"]);
  assert.deepEqual(campaignActionsFor("SCHEDULED"), ["unschedule", "cancel"]);
  assert.deepEqual(campaignActionsFor("SENDING"), ["cancel"]);
  for (const s of ["COMPLETED", "CANCELLED", "FAILED"]) assert.deepEqual(campaignActionsFor(s), [], s);
  assert.deepEqual(campaignActionsFor("bogus"), []); assert.deepEqual(campaignActionsFor(undefined), []);
  for (const s of CAMPAIGN_STATUSES) { assert.ok(CAMPAIGN_STATUS_LABEL[s]); assert.ok(!(campaignActionsFor(s) as string[]).includes("schedule"), "nothing offers to schedule"); assert.equal((campaignActionsFor(s) as string[]).includes("send_now"), s === "DRAFT", `send_now only for a draft (${s})`); }
});

// ------------------------------------------------------------------------------------------------------------------------------ list + detail

test("list and stats: newest first, status filter, name search, 20 per page, and template names", async () => {
  const tpl = await standardTemplate({ name: "Spring template" });
  for (let i = 1; i <= 25; i++) await draft(tpl, { name: `Campaign ${String(i).padStart(2, "0")}` });
  const c = campaigns(); c.forEach((row, i) => { row.createdAt = new Date(T0.getTime() + i * 1000); });
  db.patch("emailCampaign", c[0].id, { status: "CANCELLED" });
  const stats = await adminGetCampaignStats(A, { db: D() });
  assert.equal(stats.total, 25); assert.equal(stats.byStatus.DRAFT, 24); assert.equal(stats.byStatus.CANCELLED, 1);
  const p1 = await adminListCampaigns(A, {}, { db: D() });
  assert.equal(p1.rows.length, 20); assert.equal(p1.total, 25); assert.equal(p1.pageCount, 2); assert.equal(p1.rows[0].name, "Campaign 25");
  assert.equal(p1.rows[0].templateName, "Spring template"); assert.deepEqual(p1.rows[0].actions, ["edit_draft", "send_now", "cancel"]);
  const p2 = await adminListCampaigns(A, { page: "2" }, { db: D() });
  assert.equal(p2.rows.length, 5); assert.equal(p2.page, 2);
  const cancelled = await adminListCampaigns(A, { status: "CANCELLED" }, { db: D() });
  assert.equal(cancelled.total, 1); assert.deepEqual(cancelled.rows[0].actions, []);
  const found = await adminListCampaigns(A, { q: "campaign 07" }, { db: D() });
  assert.equal(found.total, 1);
  const junk = await adminListCampaigns(A, { status: "NOPE", page: "-4", q: "x".repeat(500) }, { db: D() });
  assert.equal(junk.page, 1, "junk filters never crash and never widen access");
});

test("details: campaign, template, delivery progress and recipients are read from the database; recipients are paginated 25 per page and filterable", async () => {
  const id = await draft(await standardTemplate({ name: "Detail template" }));
  for (let i = 1; i <= 30; i++) {
    const { contact, consent } = await optedIn(db, `user${String(i).padStart(2, "0")}@example.com`);
    await (db as any).emailCampaignRecipient.create({ data: { campaignId: id, contactId: contact.id, consentId: consent.id, status: i <= 20 ? "SENT" : i <= 24 ? "FAILED" : i <= 27 ? "SKIPPED" : "PENDING", skipReason: i > 24 && i <= 27 ? "suppressed" : null, errorCode: i > 20 && i <= 24 ? "timeout" : null, sentAt: i <= 20 ? T1 : null, createdAt: new Date(T0.getTime() + i * 1000) } });
  }
  const p1: any = await adminGetCampaignDetail(A, id, {}, { db: D() });
  assert.ok(p1.ok); const c = p1.campaign;
  assert.equal(c.template.name, "Detail template"); assert.equal(c.status, "DRAFT"); assert.equal(c.hasUnsubscribeLink, true);
  assert.deepEqual({ total: c.delivery.total, sent: c.delivery.sent, failed: c.delivery.failed, skipped: c.delivery.skipped, pending: c.delivery.pending }, { total: 30, sent: 20, failed: 4, skipped: 3, pending: 3 });
  assert.equal(c.delivery.processed, 27); assert.equal(c.delivery.percent, 90);
  assert.deepEqual(c.skipReasons, [{ code: "suppressed", count: 3 }]); assert.deepEqual(c.failureCodes, [{ code: "timeout", count: 4 }]);
  assert.equal(c.recipients.rows.length, 25); assert.equal(c.recipients.total, 30); assert.equal(c.recipients.pageCount, 2);
  assert.equal(c.recipients.rows[0].email, "user01@example.com");
  const p2: any = await adminGetCampaignDetail(A, id, { page: "2" }, { db: D() });
  assert.equal(p2.campaign.recipients.rows.length, 5); assert.equal(p2.campaign.recipients.page, 2);
  const failed: any = await adminGetCampaignDetail(A, id, { status: "FAILED" }, { db: D() });
  assert.equal(failed.campaign.recipients.total, 4); assert.ok(failed.campaign.recipients.rows.every((r: any) => r.status === "FAILED" && r.reason === "timeout"));
  const bogus: any = await adminGetCampaignDetail(A, id, { status: "'; DROP", page: "999999999" }, { db: D() });
  assert.ok(bogus.ok); assert.equal(bogus.campaign.recipients.status, null); assert.equal(bogus.campaign.recipients.page, 1);
  for (const bad of ["nope", "../x", "", null]) { const r: any = await adminGetCampaignDetail(A, bad, {}, { db: D() }); assert.equal(r.ok, false); assert.equal(r.code, "not_found"); }
});

test("details never expose tokens, secrets or raw server replies: only fixed lower-case codes are shown", async () => {
  const id = await draft(await standardTemplate());
  const { contact, consent } = await optedIn(db, "a@example.com");
  await (db as any).emailCampaignRecipient.create({ data: { campaignId: id, contactId: contact.id, consentId: consent.id, status: "FAILED", errorCode: "550 5.1.1 user unknown: smtp pass abcd efgh" } });
  db.patch("marketingConsent", consent.id, { unsubscribeTokenHash: "f".repeat(64) });
  db.patch("emailCampaign", id, { failureReason: "Error: connect ECONNREFUSED 10.0.0.1" });
  const r: any = await adminGetCampaignDetail(A, id, {}, { db: D() });
  assert.equal(r.campaign.recipients.rows[0].reason, null); assert.equal(r.campaign.failureCode, null);
  assert.deepEqual(r.campaign.failureCodes, [{ code: "other", count: 1 }]);
  const dump = JSON.stringify(r);
  for (const secret of ["550 5.1.1", "abcd efgh", "ECONNREFUSED", "f".repeat(64), UNSUB_SECRET, "tokenHash"]) assert.ok(!dump.includes(secret), `leaked: ${secret}`);
  assert.equal(reasonLabel("recipient_ineligible").length > 0, true); assert.equal(reasonLabel(null), "—");
});

// ------------------------------------------------------------------------------------------------------------------------------ dispatch integration

for (const kind of ["standard", "designer"] as const) {
  test(`existing dispatch stays intact (${kind} template): scheduled by the new UI layer, started by the existing scheduler, delivered by the existing worker; eligibility re-checked; marker never sent`, async () => {
    const emails = ["a@example.com", "b@example.com", "c@example.com"];
    const tpl = kind === "designer" ? await designerTemplate("ready") : await standardTemplate({ htmlBody: "<p>Hi {{firstName}}, <a href=\"{{unsubscribeUrl}}\">Unsubscribe</a></p>" });
    const id = await scheduled(emails, tpl);
    // consent is withdrawn AFTER the audience was prepared and scheduled: the existing dispatcher must still refuse to mail this person
    await suppressEmail("c@example.com", { reason: "UNSUBSCRIBED" }, { db: D(), now: T0 });
    db.patch("emailCampaign", id, { updatedAt: T0 });

    const swept = await dispatchDueCampaigns({ db: D(), now: NOW, unsubscribeEnv: GOOD_ENV });
    assert.equal(swept.dispatched, 1, JSON.stringify(swept));
    assert.equal(campaigns().find((c) => c.id === id).status, "SENDING");
    assert.equal(jobs().length, 2, "one job per STILL eligible recipient, no duplicates");
    const again = await dispatchDueCampaigns({ db: D(), now: NOW, unsubscribeEnv: GOOD_ENV });
    assert.equal(again.dispatched, 0, "a repeat does nothing"); assert.equal(jobs().length, 2);

    const worked: any = await processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW });
    assert.equal(worked.sent, 2, JSON.stringify(worked));
    assert.equal(smtp.mails.length, 2);
    for (const m of smtp.mails) {
      assert.doesNotMatch(m.html ?? "", /gp-design/); assert.doesNotMatch(m.text ?? "", /gp-design/); assert.doesNotMatch(m.html ?? "", /<!--/);
      assert.ok(/\/unsubscribe\//.test(m.text) || /\/unsubscribe\//.test(m.html), "personal unsubscribe link present");
      assert.match(String(m.headers?.["List-Unsubscribe"]), /^<https:\/\/shop\.example\.com\/.+>$/, "List-Unsubscribe header intact");
      assert.notEqual(m.to, "c@example.com", "the unsubscribed contact is never mailed");
    }
    const detail: any = await adminGetCampaignDetail(A, id, {}, { db: D() });
    assert.equal(detail.campaign.delivery.sent, 2); assert.equal(detail.campaign.delivery.skipped, 1);
    assert.equal(detail.campaign.status, "COMPLETED");
    assert.deepEqual(detail.campaign.actions, []);
  });
}

test("a cancelled scheduled campaign is never picked up by the existing scheduler", async () => {
  const id = await scheduled(["a@example.com"]);
  const c: any = await adminCancelCampaign(A, id, { db: D(), now: T0 });
  assert.equal(c.ok, true);
  db.patch("emailCampaign", id, { updatedAt: T0 });
  const swept = await dispatchDueCampaigns({ db: D(), now: NOW, unsubscribeEnv: GOOD_ENV });
  assert.equal(swept.dispatched, 0); assert.equal(jobs().length, 0);
});

// ------------------------------------------------------------------------------------------------------------------------------ scope + UI source

test("scope: the admin UI layer has no send path of its own (no SMTP, no queue, no cron dispatcher: only the existing dispatchEmailCampaign) and the pages and navigation are wired", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const files = [
    "src/server/services/admin-email-campaign.service.ts", "src/server/actions/admin-email-campaign.actions.ts", "src/lib/email-campaigns.ts",
    "src/features/admin/email-campaigns/campaign-wizard.tsx", "src/features/admin/email-campaigns/campaign-action-buttons.tsx", "src/features/admin/email-campaigns/campaigns-table.tsx",
    "src/app/admin/(dashboard)/email-marketing/campaigns/page.tsx", "src/app/admin/(dashboard)/email-marketing/campaigns/new/page.tsx", "src/app/admin/(dashboard)/email-marketing/campaigns/[id]/page.tsx",
  ];
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code only: comments may name the existing services they rely on
    assert.doesNotMatch(src, /sendSmtpMail|nodemailer|enqueueEmail|processEmailQueue|dispatchDueCampaigns|email-queue\.service|lib\/email\/smtp/, `${f} must not send or queue by itself`);
    if (!f.endsWith("admin-email-campaign.service.ts")) assert.doesNotMatch(src, /dispatchEmailCampaign/, `${f} must not call the dispatcher (only the admin service does)`);
    assert.doesNotMatch(src, /localStorage|sessionStorage/, f);
  }
  assert.doesNotMatch(read("src/server/services/admin-email-campaign.service.ts"), /marketingConsent\.(create|update|delete)|emailSuppression\.(create|update|delete)|emailJob\.(create|update|delete)/, "no consent, suppression or job writes");
  for (const f of files.filter((x) => x.endsWith("page.tsx"))) assert.match(read(f), /requireAdmin\(\)/, `${f} authenticates the admin itself`);
  for (const f of ["src/server/actions/admin-email-campaign.actions.ts"]) {
    const src = read(f);
    const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    assert.ok(exported.length >= 9);
    for (const name of exported) assert.match(src.slice(src.indexOf(`export async function ${name}`)).split("\n").slice(0, 3).join("\n"), /requireAdmin\(\)/, `${name} calls requireAdmin first`);
  }
  assert.match(read("src/config/admin-nav.ts"), /href: "\/admin\/email-marketing\/campaigns", label: "Campaigns"/);
  assert.match(read("src/features/admin/email-campaigns/campaign-wizard.tsx"), /sendCampaignNowAction/, "the wizard ends in an immediate send");
});

// ------------------------------------------------------------------------------------------------------------------------------ additive audience warning

test("additive-audience warning: shown exactly when the campaign has recipient rows, with the four required statements", () => {
  for (const none of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(audienceAdditiveWarning(none), null, String(none));
  for (const some of [1, 2, 5000]) {
    const w = audienceAdditiveWarning(some);
    assert.ok(w, String(some));
    const text = [w!.title, ...w!.points].join(" | ");
    assert.match(text, /already has recipients/i);
    assert.match(text, /already added to this campaign will remain/i);
    assert.match(text, /"All eligible contacts" to "Selected contacts" does NOT remove previously added recipients/);
    assert.match(text, /only controls which additional contacts may be added/);
    assert.match(text, /create a new campaign before preparing that audience/);
  }
});

test("additive-audience warning: the review data that drives it counts ALL recipient rows (also skipped ones) and is 0 only for an empty campaign", async () => {
  const empty = await draft(await standardTemplate(), { name: "Empty" });
  const e: any = await adminGetCampaignReview(A, empty, { db: D(), env: GOOD_ENV });
  assert.equal(e.review.audience.total, 0); assert.equal(audienceAdditiveWarning(e.review.audience.total), null);

  await optedIn(db, "a@example.com");
  const id = await draft(await standardTemplate({ name: "Second" }), { name: "With rows" });
  await prepare(id);
  const w: any = await adminGetCampaignReview(A, id, { db: D(), env: GOOD_ENV });
  assert.equal(w.review.audience.total, 1); assert.ok(audienceAdditiveWarning(w.review.audience.total));

  // the only recipient later becomes ineligible and is SKIPPED: the row still exists, so the warning still applies
  await suppressEmail("a@example.com", { reason: "UNSUBSCRIBED" }, { db: D(), now: T0 });
  await prepare(id);
  const skipped: any = await adminGetCampaignReview(A, id, { db: D(), env: GOOD_ENV });
  assert.equal(skipped.review.audience.eligible, 0); assert.equal(skipped.review.audience.skipped, 1); assert.equal(skipped.review.audience.total, 1);
  assert.ok(audienceAdditiveWarning(skipped.review.audience.total));
  // resuming at the wizard step also reports the rows (the page uses this to open the audience step with the warning)
  const resumed: any = await adminGetCampaignDraftForWizard(A, id, { db: D() });
  assert.equal(resumed.audience.total, 1);
});

test("the behaviour the warning describes is real and unchanged: switching to selected contacts never removes recipients that were already added", async () => {
  const a = await optedIn(db, "a@example.com"); await optedIn(db, "b@example.com"); const c = await optedIn(db, "c@example.com");
  const id = await draft(await standardTemplate());
  const first = await prepare(id); // all eligible contacts
  assert.equal(first.audience.total, 3);
  const second = await prepare(id, { contactIds: [c.contact.id] }); // "selected contacts" with ONE contact
  assert.equal(second.audience.total, 3, "recipients added earlier remain");
  assert.equal(second.run.added, 0); assert.equal(second.run.alreadyPrepared, 1);
  assert.equal(recipients(id).length, 3);
  assert.ok(recipients(id).some((r: any) => r.contactId === a.contact.id), "history kept");
  assert.equal(jobs().length, 0, "still nothing queued");
});

test("additive-audience warning is rendered in the Audience and Review & send steps, is not dismissible, and no reset or delete feature was added (source check, not a browser test)", () => {
  const src = readFileSync("src/features/admin/email-campaigns/campaign-wizard.tsx", "utf8");
  const uses = [...src.matchAll(/<AudienceAdditiveNotice recipientRows=\{([^}]+)\} \/>/g)].map((m) => m[1]);
  assert.deepEqual(uses, ["audience?.total ?? 0", "review.audience.total"], "Audience step and Review & send step");
  const notice = src.slice(src.indexOf("function AudienceAdditiveNotice"), src.indexOf("function Stat("));
  assert.match(notice, /audienceAdditiveWarning\(recipientRows\)/); assert.match(notice, /role="note"/);
  assert.doesNotMatch(notice, /useState|onClick|dismiss|close/i, "persistent: no state, no close button");
  const code = ["src/server/services/admin-email-campaign.service.ts", "src/server/actions/admin-email-campaign.actions.ts", "src/features/admin/email-campaigns/campaign-wizard.tsx"].map((f) => readFileSync(f, "utf8")).join("\n");
  assert.doesNotMatch(code, /emailCampaignRecipient\.(delete|deleteMany)|resetAudience|clearAudience|removeRecipient/i, "no recipient deletion or audience reset");
});
