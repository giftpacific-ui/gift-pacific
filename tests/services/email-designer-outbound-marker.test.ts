/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * P12-UI-02 follow-up: the internal `<!--gp-design:v1:...-->` marker (the stored design + draft/ready status, kept at the end of EmailTemplate.htmlBody) must
 * NEVER reach a customer. The REAL template designer, template, campaign, dispatch, queue-worker and SMTP code runs underneath (in-memory database, fake SMTP
 * transport). The stored template keeps its marker (editing, duplicating, draft/ready, campaign eligibility); everything OUTBOUND is clean.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, freshDb, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { captureLogs, makeSmtp, NOW, scheduledCampaign, SMTP_ENV } from "../setup/campaign-dispatch-fixture";
import { defaultDesign, newBlock, type Block, type Design } from "@/lib/email-template-blocks";
import { isDesignerDraft, isDesignerTemplate, readStoredDesign, stripDesignMarker } from "@/lib/email/designer/design";
import { renderEmailTemplate } from "@/lib/email/template-rules";
import {
  adminDuplicateEmailTemplate, adminGetEmailTemplateForEditor, adminPreviewEmailDesign, adminPreviewSavedEmailTemplate, adminSaveEmailTemplate, adminSendTemplateTestEmail,
} from "@/server/services/email-template-designer.service";
import { createEmailTemplate, getEmailTemplate } from "@/server/services/email-template.service";
import { createEmailCampaign, getEmailCampaign, updateEmailCampaign } from "@/server/services/email-campaign.service";
import { dispatchEmailCampaign } from "@/server/services/email-campaign-dispatch.service";
import { enqueueEmail, processEmailQueue } from "@/server/services/email-queue.service";

let db: FakeDb;
let smtp: ReturnType<typeof makeSmtp>;
let logs: ReturnType<typeof captureLogs>;
const SAVED_ENV: Record<string, string | undefined> = {};
beforeEach(() => {
  SAVED_ENV.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED;
  process.env.RATE_LIMIT_ENABLED = "false";
  db = freshDb(); smtp = makeSmtp(); discardAfter(); seedAdmins(db); logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  if (SAVED_ENV.RATE_LIMIT_ENABLED === undefined) delete process.env.RATE_LIMIT_ENABLED; else process.env.RATE_LIMIT_ENABLED = SAVED_ENV.RATE_LIMIT_ENABLED;
});

const A = "admin-1";
const D = () => db as never;
const ENV = { NEXT_PUBLIC_APP_URL: "https://giftpacific.test", NODE_ENV: "test", ...SMTP_ENV, SMTP_FROM_NAME: "GiftPacific", SMTP_FROM_EMAIL: "" };
const opts = () => ({ db: D(), env: ENV });
const MARK = /gp-design/;

const textBlock = (body: string): Block => ({ ...newBlock("text"), heading: "Weekend offer", body }) as Block;
const design = (): Design => { const x = defaultDesign(); return { preheader: "Sneak peek", blocks: [x.blocks[0], textBlock("Dear {{customerName}}, enjoy **20% off** at {{storeName}}. [Shop now](/shop)"), x.blocks[x.blocks.length - 1]] }; };
const save = async (over: Record<string, unknown> = {}) => {
  const r: any = await adminSaveEmailTemplate(A, { name: "Winter sale", category: "MARKETING", subject: "Hello {{firstName}}", status: "ready", design: design(), ...over }, opts());
  assert.ok(r.ok, JSON.stringify(r));
  return r as { id: string };
};
const tplRow = (id: string) => db.rows("emailTemplate").find((t: any) => t.id === id) as any;
const campaigns = () => db.rows("emailCampaign") as any[];
const jobs = () => db.rows("emailJob") as any[];
/** What the template looked like before the designer attached its marker: the stored body minus the marker. */
const withoutMarker = (stored: string) => stored.replace(/\n<!--gp-design:v1:(draft|ready):[0-9a-f]+-->$/, "");

/** A campaign built the real way from a designer template (stored htmlBody + textBody exactly as the designer saved them), scheduled and ready to dispatch. */
async function designerCampaign(status: "draft" | "ready" = "ready", emails = ["a@example.com"]) {
  const saved = await save({ status, name: `Designer ${status}` });
  const row = tplRow(saved.id);
  const f = await scheduledCampaign(db, emails, { htmlBody: row.htmlBody, textBody: row.textBody, name: "Designer campaign" });
  return { f, row };
}
const runWorker = () => processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW });

// ------------------------------------------------------------------------------------------------------------------------------ stored metadata kept

test("stored designer templates keep their marker: draft/ready is readable, the editor loads the design, the template service returns the body as stored", async () => {
  const draft = await save({ status: "draft", name: "D" }), ready = await save({ status: "ready", name: "R" });
  for (const [saved, status] of [[draft, "draft"], [ready, "ready"]] as const) {
    const row = tplRow(saved.id);
    assert.match(row.htmlBody, /<!--gp-design:v1:(draft|ready):[0-9a-f]+-->$/, "the marker is still stored at the end of htmlBody");
    assert.equal(readStoredDesign(row.htmlBody)?.status, status);
    assert.equal(isDesignerTemplate(row.htmlBody), true);
    assert.equal((await getEmailTemplate(saved.id, { db: D() }) as any).template.htmlBody, row.htmlBody, "the template service returns the stored body untouched");
  }
  assert.equal(isDesignerDraft(tplRow(draft.id).htmlBody), true);
  assert.equal(isDesignerDraft(tplRow(ready.id).htmlBody), false);
  const editor: any = await adminGetEmailTemplateForEditor(A, ready.id, opts());
  assert.ok(editor.ok, JSON.stringify(editor));
  assert.deepEqual(editor.template.design.blocks.map((b: Block) => b.type), ["header", "text", "footer"], "an existing template stays editable");
});

test("editing and duplicating keep the design: an edit re-saves the marker, a duplicate is a draft copy with the same design", async () => {
  const made = await save({ status: "ready" });
  const edited: any = await save({ id: made.id, status: "draft", design: { ...design(), preheader: "Changed" } });
  assert.equal(edited.id, made.id);
  assert.equal(readStoredDesign(tplRow(made.id).htmlBody)?.status, "draft");
  assert.equal((readStoredDesign(tplRow(made.id).htmlBody)?.design as any).preheader, "Changed");
  const copy: any = await adminDuplicateEmailTemplate(A, made.id, opts());
  assert.ok(copy.ok, JSON.stringify(copy));
  assert.equal(isDesignerDraft(tplRow(copy.id).htmlBody), true);
  assert.deepEqual(readStoredDesign(tplRow(copy.id).htmlBody)?.design, readStoredDesign(tplRow(made.id).htmlBody)?.design);
});

// ------------------------------------------------------------------------------------------------------------------------------ campaign snapshots

test("a campaign snapshot never contains the marker; the template keeps it; the snapshot is exactly the template body minus the marker", async () => {
  const saved = await save({ status: "ready" });
  const stored = tplRow(saved.id).htmlBody as string;
  assert.match(stored, MARK);
  const c: any = await createEmailCampaign({ name: "Snap", templateId: saved.id }, { db: D() });
  assert.ok(c.ok, JSON.stringify(c));
  const row = campaigns()[0];
  assert.doesNotMatch(row.htmlBody, MARK, "the stored snapshot is clean");
  assert.doesNotMatch(c.campaign.htmlBody, MARK, "and so is the view returned to the admin");
  assert.equal(row.htmlBody, withoutMarker(stored), "content, unsubscribe link and placeholders are untouched");
  assert.match(row.htmlBody, /<a href="\{\{unsubscribeUrl\}\}"/);
  assert.match(row.htmlBody, /\{\{customerName\}\}/); assert.match(row.htmlBody, /\{\{storeName\}\}/);
  assert.equal(row.textBody, tplRow(saved.id).textBody, "the text body is the template's, unchanged");
  assert.equal(tplRow(saved.id).htmlBody, stored, "creating a campaign does not touch the stored template");
  assert.equal(((await getEmailCampaign(row.id, { db: D() })) as any).campaign.htmlBody, row.htmlBody);
});

test("switching a draft campaign to a designer template takes a clean snapshot too", async () => {
  const plain: any = await createEmailTemplate({ name: "Plain", subject: "s", textBody: "Hi {{unsubscribeUrl}}", htmlBody: "<p>plain {{unsubscribeUrl}}</p>" }, { db: D() });
  const saved = await save({ status: "ready" });
  const c: any = await createEmailCampaign({ name: "Switch", templateId: plain.template.id }, { db: D() });
  const u: any = await updateEmailCampaign(c.campaign.id, { templateId: saved.id }, { db: D() });
  assert.ok(u.ok, JSON.stringify(u));
  assert.equal(campaigns()[0].templateId, saved.id);
  assert.doesNotMatch(campaigns()[0].htmlBody, MARK);
  assert.equal(campaigns()[0].htmlBody, withoutMarker(tplRow(saved.id).htmlBody));
});

// ------------------------------------------------------------------------------------------------------- dispatch -> EmailJob -> worker -> SMTP

test("designer campaign end to end: snapshot, EmailJob payload and the final SMTP HTML are all clean, and keep content, unsubscribe link and headers", async () => {
  const { f, row } = await designerCampaign("ready", ["a@example.com", "b@example.com"]);
  assert.doesNotMatch(campaigns()[0].htmlBody, MARK, "snapshot");
  const r: any = await dispatchEmailCampaign(f.campaignId, { db: D(), now: NOW });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(jobs().length, 2);
  for (const j of jobs()) { assert.ok(j.html && j.html.length > 100); assert.doesNotMatch(j.html, MARK, "EmailJob payload"); assert.doesNotMatch(j.text, MARK); }
  const w = await runWorker();
  assert.equal(w.sent, 2, JSON.stringify(w));
  assert.equal(smtp.mails.length, 2);
  for (const m of smtp.mails) {
    assert.doesNotMatch(m.html, MARK, "final SMTP HTML");
    assert.doesNotMatch(m.html, /<!--/, "no comment of any kind is left in the generated e-mail");
    assert.doesNotMatch(m.text, MARK);
    assert.match(m.html, /Dear [A-Za-z ]+, enjoy <strong>20% off<\/strong>/, "the real content is intact and personalised");
    assert.match(m.html, /Weekend offer/);
    const link = /<a href="(https:\/\/shop\.example\.com\/[^"]+)"[^>]*>Unsubscribe<\/a>/.exec(m.html)?.[1];
    assert.ok(link, "the unsubscribe link is in the HTML"); assert.ok(m.text.includes(link!), "and in the text");
    assert.equal(m.headers["List-Unsubscribe"], `<${link}>`, "List-Unsubscribe is unchanged");
    assert.doesNotMatch(m.html, /\{\{/, "every placeholder was filled");
  }
  assert.ok(row.htmlBody.includes("gp-design"), "the template itself still carries its marker");
});

test("snapshots made BEFORE this fix (marker already stored in the campaign) are cleaned when the EmailJob is built", async () => {
  const { f, row } = await designerCampaign("ready");
  db.patch("emailCampaign", f.campaignId, { htmlBody: row.htmlBody }); // the old behaviour: the snapshot was a verbatim copy including the marker
  assert.match(campaigns()[0].htmlBody, MARK);
  const r: any = await dispatchEmailCampaign(f.campaignId, { db: D(), now: NOW });
  assert.ok(r.ok, JSON.stringify(r));
  assert.doesNotMatch(jobs()[0].html, MARK);
  assert.equal((await runWorker()).sent, 1);
  assert.doesNotMatch(smtp.mails[0].html, MARK);
});

test("EmailJobs queued BEFORE this fix (marker inside the stored job HTML) are cleaned by the worker right before SMTP", async () => {
  const { f } = await designerCampaign("ready");
  assert.ok(((await dispatchEmailCampaign(f.campaignId, { db: D(), now: NOW })) as any).ok);
  const stored = jobs()[0].html as string;
  const dirty = `${stored}\n<!--gp-design:v1:ready:7b22626c6f636b73223a5b5d7d-->`;
  db.patch("emailJob", jobs()[0].id, { html: dirty });
  assert.match(jobs()[0].html, MARK);
  assert.equal((await runWorker()).sent, 1);
  assert.doesNotMatch(smtp.mails[0].html, MARK);
  assert.equal(smtp.mails[0].html, stored, "exactly the clean HTML is sent: nothing else was changed");
});

test("a non-campaign job (any other kind) is cleaned by the same worker step, and only the marker is removed", async () => {
  const html = "<p>Hello</p>\n<!--gp-design:v1:draft:7b7d-->";
  assert.ok(((await enqueueEmail({ kind: "other", dedupeParts: ["x"], to: "t@example.com", subject: "S", text: "T", html }, { db: D(), now: NOW })) as any).ok);
  assert.equal((await runWorker()).sent, 1);
  assert.equal(smtp.mails[0].html, "<p>Hello</p>");
});

// ------------------------------------------------------------------------------------------------------------------ draft / ready gating

test("draft designer templates stay blocked from campaigns; ready ones stay usable; marking a draft ready unblocks it", async () => {
  const draft = await save({ status: "draft", name: "Draft one" });
  const blocked: any = await createEmailCampaign({ name: "C1", templateId: draft.id }, { db: D() });
  assert.equal(blocked.ok, false); assert.equal(blocked.reason, "template_not_ready");
  const ready = await save({ status: "ready", name: "Ready one" });
  assert.ok(((await createEmailCampaign({ name: "C2", templateId: ready.id }, { db: D() })) as any).ok);
  // a campaign cannot be switched onto a draft either
  const c: any = await createEmailCampaign({ name: "C3", templateId: ready.id }, { db: D() });
  const sw: any = await updateEmailCampaign(c.campaign.id, { templateId: draft.id }, { db: D() });
  assert.equal(sw.ok, false); assert.equal(sw.reason, "template_not_ready");
  assert.ok(((await save({ id: draft.id, status: "ready", name: "Draft one" })) as any).ok);
  assert.ok(((await createEmailCampaign({ name: "C4", templateId: draft.id }, { db: D() })) as any).ok);
  assert.equal(campaigns().length, 3, "only the three allowed campaigns exist");
});

// ------------------------------------------------------------------------------------------------------------- previews and the test e-mail

test("previews and the test e-mail are clean customer-facing HTML (saved template, unsaved design) and still contain the content and unsubscribe link", async () => {
  const saved = await save({ status: "ready" });
  assert.match(tplRow(saved.id).htmlBody, MARK);
  const sp: any = await adminPreviewSavedEmailTemplate(A, saved.id, opts());
  assert.ok(sp.ok, JSON.stringify(sp));
  assert.doesNotMatch(sp.html, MARK); assert.match(sp.html, /Weekend offer/); assert.match(sp.html, /href="https:\/\/giftpacific\.test\/unsubscribe\/sample-preview-link"/);
  assert.equal(sp.isDesigner, true); assert.equal(sp.status, "active", "the status is still read from the stored marker");
  const up: any = await adminPreviewEmailDesign(A, { subject: "Hi", design: design() }, opts());
  assert.ok(up.ok); assert.doesNotMatch(up.html, MARK);
  const sent: any[] = [];
  const factory = () => ({ verify: async () => true, sendMail: async (m: any) => { sent.push(m); return { messageId: "<i@x>", accepted: [m.to], rejected: [] }; }, close: () => {} });
  const t: any = await adminSendTemplateTestEmail(A, { recipient: "tester@example.com", templateId: saved.id }, { ...opts(), factory } as never);
  assert.equal(t.success, true, JSON.stringify(t));
  assert.doesNotMatch(sent[0].html, MARK); assert.doesNotMatch(sent[0].text, MARK);
  assert.match(sent[0].html, /Weekend offer/); assert.match(sent[0].html, /unsubscribe\/sample-preview-link/);
  const t2: any = await adminSendTemplateTestEmail(A, { recipient: "tester@example.com", design: design(), subject: "Hi" }, { ...opts(), factory } as never);
  assert.equal(t2.success, true); assert.doesNotMatch(sent[1].html, MARK);
});

// ------------------------------------------------------------------------------------------------------------- templates made elsewhere

test("templates that were not made in the designer behave exactly as before, byte for byte, from snapshot to SMTP", async () => {
  const html = "<html><body><!-- keep this comment -->\n<p>Hi {{firstName}}, see {{storeName}}.</p>\n<p><a href=\"{{unsubscribeUrl}}\">Unsubscribe</a></p>  \n</body></html>\n\n";
  const f = await scheduledCampaign(db, ["a@example.com"], { htmlBody: html, textBody: "Hello {{customerName}} {{unsubscribeUrl}}" });
  assert.equal(campaigns()[0].htmlBody, html, "the snapshot is the template body verbatim (comments and trailing whitespace included)");
  assert.equal(tplRow(f.templateId).htmlBody, html);
  assert.ok(((await dispatchEmailCampaign(f.campaignId, { db: D(), now: NOW })) as any).ok);
  const expected = renderEmailTemplate({ subject: "x", textBody: "x {{unsubscribeUrl}}", htmlBody: html }, { customerName: "A Tester", firstName: "A", email: "a@example.com", storeName: "Gift Pacific", unsubscribeUrl: /href="([^"]+)"/.exec(jobs()[0].html)![1] } as never) as any;
  assert.ok(expected.ok);
  const queued = jobs()[0].html as string; // (the worker drops the stored body once it has sent)
  assert.equal(queued, expected.htmlBody, "the EmailJob HTML is exactly what the unchanged renderer produces");
  assert.equal((await runWorker()).sent, 1);
  assert.equal(smtp.mails[0].html, queued, "and SMTP receives that HTML unchanged");
  assert.match(smtp.mails[0].html, /keep this comment/);
  const plain: any = await createEmailTemplate({ name: "Plain", subject: "s", textBody: "Hi" }, { db: D() }); // no html, no unsubscribe link: judged exactly as before
  assert.ok(((await createEmailCampaign({ name: "P", templateId: plain.template.id }, { db: D() })) as any).ok);
  assert.equal(campaigns().find((c) => c.name === "P").htmlBody, null);
});

test("stripDesignMarker: removes only the designer marker, restores the pre-marker HTML, and leaves every other string identical", () => {
  const base = "<p>Hi {{firstName}} <a href=\"{{unsubscribeUrl}}\">Unsubscribe</a></p>";
  for (const status of ["draft", "ready"]) assert.equal(stripDesignMarker(`${base}\n<!--gp-design:v1:${status}:7b7d-->`), base);
  assert.equal(stripDesignMarker(`${base}<!--gp-design:v1:ready:7b7d-->`), base, "also without the newline");
  assert.equal(stripDesignMarker(`${base}\n<!--gp-design:v1:ready:7b7d-->\n`), `${base}\n`, "trailing whitespace after the marker is kept as it was");
  assert.equal(stripDesignMarker(`<!--gp-design:v1:ready:aa--><p>x</p>\n<!--gp-design:v1:draft:bb-->`), "<p>x</p>", "a marker anywhere, even repeated, never survives");
  assert.equal(stripDesignMarker(`${base}\n<!--gp-design:v2:ready:7b7d-->`), base, "a future version is stripped as well");
  assert.equal(stripDesignMarker(null), null);
  assert.equal(stripDesignMarker(""), "");
  for (const same of [base, `${base}\n`, "<!-- gp -->", "<!-- hello --> <p>x</p>  \n", "plain text, gp-design mentioned in prose", "<p>{{unsubscribeUrl}}</p>"]) assert.equal(stripDesignMarker(same), same);
  const broken = "<p>keep</p><!--gp-design:v1:ready:7b7d <p>and this</p><!-- other -->";
  assert.equal(stripDesignMarker(broken), broken, "a malformed marker can never swallow real content");
});
