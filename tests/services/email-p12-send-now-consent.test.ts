/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * P12 focused changes: (1) immediate send instead of scheduling, (2) consent management for an existing contact, (3) the strict marketing /
 * transactional distinction (what the existing architecture supports, and the proof that no consent bypass exists). Runs the REAL existing campaign,
 * dispatch, queue-worker, consent, suppression and eligibility code on the in-memory database; nothing here re-implements production logic.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { discardAfter, freshDb, runAs, seedAdmins } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { captureLogs, makeSmtp, NOW, optedIn, SMTP_ENV, T0, UNSUB_BASE, UNSUB_SECRET } from "../setup/campaign-dispatch-fixture";
import { createEmailTemplate } from "@/server/services/email-template.service";
import { upsertEmailContact, setEmailContactActive } from "@/server/services/email-contact.service";
import { recordMarketingConsent } from "@/server/services/marketing-consent.service";
import { suppressEmail } from "@/server/services/email-suppression.service";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { dispatchDueCampaigns } from "@/server/services/email-campaign-scheduler.service";
import { processEmailQueue } from "@/server/services/email-queue.service";
import { adminGetCampaignDetail, adminPrepareCampaignAudience, adminSaveCampaignDraft, adminSendCampaignNow } from "@/server/services/admin-email-campaign.service";
import { adminCreateEmailContact, adminGetEmailContactDetail, adminRecordContactConsent, adminWithdrawContactConsent } from "@/server/services/email-contact-admin.service";
import { sendCampaignNowAction } from "@/server/actions/admin-email-campaign.actions";
import { recordEmailContactConsentAction, withdrawEmailContactConsentAction } from "@/server/actions/admin-email-contact.actions";
import { campaignActionsFor } from "@/lib/email-campaigns";

let db: FakeDb;
let smtp: ReturnType<typeof makeSmtp>;
let logs: ReturnType<typeof captureLogs>;
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  SAVED.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED;
  process.env.RATE_LIMIT_ENABLED = "false";
  db = freshDb(); smtp = makeSmtp(); discardAfter(); seedAdmins(db);
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer Nine", role: "CUSTOMER", isActive: true });
  db.insert("user", { id: "adm-off", email: "off@staff.test", name: "Deactivated", role: "ADMIN", isActive: false });
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  if (SAVED.RATE_LIMIT_ENABLED === undefined) delete process.env.RATE_LIMIT_ENABLED; else process.env.RATE_LIMIT_ENABLED = SAVED.RATE_LIMIT_ENABLED;
});

const A = "admin-1";
const D = () => db as never;
const GOOD_ENV = { EMAIL_UNSUBSCRIBE_SECRET: UNSUB_SECRET, NEXT_PUBLIC_APP_URL: UNSUB_BASE };
const EVIDENCE = "Ticked the newsletter box on the 2026 sign-up sheet";
const campaigns = () => db.rows("emailCampaign") as any[];
const recipients = (id?: string) => (db.rows("emailCampaignRecipient") as any[]).filter((r) => !id || r.campaignId === id);
const jobs = () => db.rows("emailJob") as any[];
const contacts = () => db.rows("emailContact") as any[];
const consentRows = (contactId?: string) => (db.rows("marketingConsent") as any[]).filter((c) => !contactId || c.contactId === contactId);
const audits = (action?: string) => (db.rows("adminAuditEvent") as any[]).filter((a) => !action || a.action === action);
const elig = (email: string, now = NOW) => getMarketingEligibility(email, { db: D(), now });
const send = (id: string, over: Record<string, unknown> = {}) => adminSendCampaignNow(A, id, { db: D(), now: NOW, unsubscribeEnv: GOOD_ENV, ...over }) as Promise<any>;

async function template(name = "Standard") {
  const t: any = await createEmailTemplate({ name, subject: "Hi {{firstName}}", textBody: "Hello {{customerName}}, welcome to {{storeName}}. Unsubscribe: {{unsubscribeUrl}}", htmlBody: '<p>Hello {{customerName}}</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>' }, { db: D() });
  assert.ok(t.ok, JSON.stringify(t));
  return t.template.id as string;
}
async function draftWithAudience(emails: string[], name = "Winter campaign") {
  for (const e of emails) await optedIn(db, e);
  const saved: any = await adminSaveCampaignDraft(A, { name, templateId: await template(`T ${name}`) }, { db: D() });
  assert.ok(saved.ok, JSON.stringify(saved));
  const prep: any = await adminPrepareCampaignAudience(A, saved.id, {}, { db: D(), now: T0 });
  assert.ok(prep.ok && prep.audience.eligible >= emails.length, JSON.stringify(prep));
  return saved.id as string;
}
async function contact(email: string, over: { consent?: boolean; suppress?: "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED" | "ADMIN"; inactive?: boolean } = {}) {
  const r: any = await upsertEmailContact({ email, source: "MANUAL", name: "Pat Example" }, { db: D() });
  assert.ok(r.ok, JSON.stringify(r));
  if (over.consent) assert.ok((await recordMarketingConsent(r.contact.id, { source: "SIGNUP_FORM" }, { db: D(), now: new Date(T0.getTime() - 3_600_000) })).ok);
  if (over.suppress) await suppressEmail(email, { reason: over.suppress }, { db: D(), now: new Date(T0.getTime() - 1_800_000) });
  if (over.inactive) await setEmailContactActive(r.contact.id, false, { db: D() });
  return r.contact as { id: string; email: string };
}

// ------------------------------------------------------------------------------------------------------------------------------ 1. immediate send

test("send now: a DRAFT goes through the EXISTING dispatcher into the EXISTING queue, nothing is sent by the call itself, and the existing worker delivers it", async () => {
  const id = await draftWithAudience(["a@example.com", "b@example.com"]);
  const res = await send(id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.outcome, "queued"); assert.equal(res.enqueued, 2);
  assert.equal(campaigns().find((c) => c.id === id).status, "SENDING");
  assert.equal(campaigns().find((c) => c.id === id).scheduledAt.getTime(), NOW.getTime(), "due now: the only instant used is the server's, never a browser time");
  assert.equal(jobs().length, 2);
  assert.ok(jobs().every((j) => j.kind === "campaign" && j.priority === 1), "campaign kind, bulk priority: the same queue entries the scheduler creates");
  assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 2);
  assert.ok(recipients(id).every((r) => r.status === "QUEUED" && jobs().some((j) => j.id === r.emailJobId)));
  assert.equal(smtp.mails.length, 0, "queued is not sent: sending is the worker's job");
  assert.ok(audits("email_campaign.send_now").some((a) => a.entityId === id && a.actorId === A));

  const worked: any = await processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW });
  assert.equal(worked.sent, 2, JSON.stringify(worked));
  assert.equal(smtp.mails.length, 2);
  for (const m of smtp.mails) assert.match(String(m.headers?.["List-Unsubscribe"]), /^<https:\/\/shop\.example\.com\/.+>$/, "the unsubscribe headers still apply");
  const detail: any = await adminGetCampaignDetail(A, id, {}, { db: D() });
  assert.equal(detail.campaign.status, "COMPLETED"); assert.equal(detail.campaign.delivery.sent, 2);
});

test("send now twice (a double click): exactly one dispatch, no recipient gets a second job", async () => {
  const id = await draftWithAudience(["a@example.com", "b@example.com", "c@example.com"]);
  const [one, two] = await Promise.all([send(id), send(id)]);
  assert.equal([one, two].filter((r) => r.ok && r.outcome === "queued").length, 1, JSON.stringify([one, two]));
  assert.equal(jobs().length, 3); assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 3);
  const third = await send(id);
  assert.equal(third.ok, false); assert.equal(third.code, "invalid_transition");
  assert.equal(jobs().length, 3);
  const sweep = await dispatchDueCampaigns({ db: D(), now: NOW, unsubscribeEnv: GOOD_ENV });
  assert.equal(sweep.dispatched, 0, "the cron safety net finds nothing to start for a campaign that is already sending");
  assert.equal(jobs().length, 3);
});

test("send now re-checks every recipient at that moment: someone who unsubscribed after the audience was prepared gets nothing", async () => {
  const id = await draftWithAudience(["a@example.com", "b@example.com", "c@example.com"]);
  await suppressEmail("c@example.com", { reason: "UNSUBSCRIBED" }, { db: D(), now: T0 });
  const res = await send(id);
  assert.equal(res.ok, true, JSON.stringify(res)); assert.equal(res.enqueued, 2); assert.equal(res.skipped, 1);
  assert.equal(jobs().length, 2); assert.ok(jobs().every((j) => j.toEmail !== "c@example.com"));
  const skipped = recipients(id).find((r) => r.status === "SKIPPED");
  assert.equal(skipped.skipReason, "suppressed"); assert.equal(skipped.emailJobId, null);
});

test("send now with nobody eligible any more: nothing is queued and the campaign goes back to DRAFT (it is not left due for the cron to fire later)", async () => {
  const id = await draftWithAudience(["a@example.com"]);
  await suppressEmail("a@example.com", { reason: "BOUNCED" }, { db: D(), now: T0 });
  const res = await send(id);
  assert.equal(res.ok, false); assert.equal(res.code, "no_eligible_recipients");
  const c = campaigns().find((x) => x.id === id);
  assert.equal(c.status, "DRAFT"); assert.equal(c.scheduledAt, null);
  assert.equal(jobs().length, 0);
  const sweep = await dispatchDueCampaigns({ db: D(), now: NOW, unsubscribeEnv: GOOD_ENV });
  assert.equal(sweep.processed, 0); assert.equal(jobs().length, 0);
});

test("send now refuses before touching anything when the unsubscribe prerequisites are missing; the draft stays a draft", async () => {
  const id = await draftWithAudience(["a@example.com"]);
  const noSecret = await send(id, { unsubscribeEnv: { NEXT_PUBLIC_APP_URL: UNSUB_BASE } });
  assert.equal(noSecret.ok, false); assert.equal(noSecret.code, "unsubscribe_link_unavailable");
  db.patch("emailCampaign", id, { textBody: "No link in this message at all" });
  const noLink = await send(id);
  assert.equal(noLink.ok, false); assert.equal(noLink.code, "unsubscribe_link_missing");
  const c = campaigns().find((x) => x.id === id);
  assert.equal(c.status, "DRAFT"); assert.equal(c.scheduledAt, null); assert.equal(jobs().length, 0);
  assert.ok(!JSON.stringify([noSecret, noLink]).includes(UNSUB_SECRET));
});

test("send now refuses a campaign without a prepared audience", async () => {
  const saved: any = await adminSaveCampaignDraft(A, { name: "Empty", templateId: await template() }, { db: D() });
  const res = await send(saved.id);
  assert.equal(res.ok, false); assert.equal(res.code, "no_recipients");
  assert.equal(campaigns()[0].status, "DRAFT"); assert.equal(jobs().length, 0);
});

test("send now only works on a draft: sending, cancelled, completed, failed and legacy-scheduled campaigns are refused and nothing is queued", async () => {
  for (const status of ["SENDING", "CANCELLED", "COMPLETED", "FAILED", "SCHEDULED"]) {
    const id = await draftWithAudience([`${status.toLowerCase()}@example.com`], `Campaign ${status}`);
    db.patch("emailCampaign", id, { status, scheduledAt: status === "SCHEDULED" ? NOW : null });
    const res = await send(id);
    assert.equal(res.ok, false, status); assert.equal(res.code, "invalid_transition", status);
    assert.equal(campaigns().find((c) => c.id === id).status, status);
  }
  assert.equal(jobs().length, 0);
});

test("send now is for admins only: a customer, a deactivated admin and a signed-out visitor change nothing", async () => {
  const id = await draftWithAudience(["a@example.com"]);
  for (const who of ["cust-9", "adm-off", null, undefined, "nobody"]) {
    const res: any = await adminSendCampaignNow(who, id, { db: D(), now: NOW, unsubscribeEnv: GOOD_ENV });
    assert.equal(res.ok, false); assert.equal(res.code, "forbidden");
  }
  await assert.rejects(runAs(null, () => sendCampaignNowAction(id) as never), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "cust-9" }, () => sendCampaignNowAction(id) as never), /FORBIDDEN/);
  assert.equal(campaigns().find((c) => c.id === id).status, "DRAFT"); assert.equal(jobs().length, 0);
});

test("send now through the server action works for an admin and is audited", async () => {
  const id = await draftWithAudience(["a@example.com"]);
  const res: any = await runAs("admin", () => sendCampaignNowAction(id) as never);
  assert.equal(res.success, true, JSON.stringify(res)); assert.equal(res.outcome, "queued"); assert.equal(res.enqueued, 1);
  assert.equal(jobs().length, 1);
  const again: any = await runAs("admin", () => sendCampaignNowAction(id) as never);
  assert.equal(again.success, false);
  assert.equal(jobs().length, 1);
});

test("an interrupted send-now leaves the campaign SENDING and resumable (by the admin's Continue sending, or the protected dispatcher route if an operator calls it), and the resume duplicates nothing", async () => {
  const id = await draftWithAudience(["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"]);
  const orig = (db as any).delegate.bind(db);
  let calls = 0;
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailJob") { const cm = d.createMany.bind(d); d.createMany = async (a: any) => { calls++; if (calls === 2) { await cm({ ...a, data: a.data.slice(0, 1) }); throw new Error("disk full"); } return cm(a); }; }
    return d;
  };
  const res = await send(id, { chunkSize: 2 });
  delete (db as any).delegate;
  assert.equal(res.ok, true); assert.equal(res.outcome, "partial"); assert.equal(res.enqueued, 2);
  assert.match(res.message, /Do not send the campaign again.*Continue sending/); // no automatic dispatcher is promised: the admin continues it
  assert.equal(campaigns().find((c) => c.id === id).status, "SENDING"); assert.equal(jobs().length, 2);
  assert.ok(!JSON.stringify(logs.lines).includes("@example.com"), "no address is logged");

  db.patch("emailCampaign", id, { updatedAt: T0 }); // untouched for longer than the stale window: the existing sweep resumes it
  const sweep = await dispatchDueCampaigns({ db: D(), now: NOW, chunkSize: 2, unsubscribeEnv: GOOD_ENV });
  assert.equal(sweep.resumed, 1, JSON.stringify(sweep));
  assert.equal(jobs().length, 5); assert.equal(new Set(jobs().map((j) => j.dedupeKey)).size, 5);
});

test("a consent withdrawn AFTER the e-mail was queued is honoured by the existing worker: that person is not mailed", async () => {
  const id = await draftWithAudience(["a@example.com", "b@example.com"]);
  assert.equal((await send(id)).ok, true);
  const b = contacts().find((c) => c.email === "b@example.com");
  const w: any = await adminWithdrawContactConsent(A, b.id, {}, { db: D(), now: NOW });
  assert.equal(w.outcome, "withdrawn");
  const worked: any = await processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW });
  assert.equal(worked.sent, 1, JSON.stringify(worked));
  assert.deepEqual(smtp.mails.map((m) => m.to), ["a@example.com"]);
  assert.equal(recipients(id).find((r) => r.contactId === b.id).status, "SKIPPED");
});

// ------------------------------------------------------------------------------------------------------------------------------ no scheduling in the UI

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

test("the campaign UI has no scheduling controls: no date or time input, no Schedule step, no schedule action, no link to a schedule step", () => {
  const files = [
    ...walk("src/features/admin/email-campaigns"),
    "src/app/admin/(dashboard)/email-marketing/campaigns/new/page.tsx",
  ];
  for (const f of files) {
    const src = code(f);
    assert.doesNotMatch(src, /datetime-local|type="date"|type="time"|type=\{?"?(date|time)/i, `${f}: no date or time input`);
    if (f.endsWith("campaign-wizard.tsx") || f.endsWith("new/page.tsx")) assert.doesNotMatch(src, /schedul/i, `${f}: the creation and editing flow never mentions scheduling`);
    assert.doesNotMatch(src, /(?<![A-Za-z])scheduleCampaignAction|step=5|ReviewAndSchedule|CalendarClock/, f);
  }
  const wizard = read("src/features/admin/email-campaigns/campaign-wizard.tsx");
  assert.match(wizard, /const STEPS = \["Details", "Template", "Audience", "Review & send"\] as const;/);
  assert.match(wizard, /sendCampaignNowAction/);
  assert.match(read("src/server/actions/admin-email-campaign.actions.ts"), /export async function sendCampaignNowAction/);
  assert.doesNotMatch(code("src/server/actions/admin-email-campaign.actions.ts"), /(?<![A-Za-z])scheduleCampaignAction|(?<![A-Za-z])adminScheduleCampaign/);
  for (const s of ["DRAFT", "SCHEDULED", "SENDING", "COMPLETED", "CANCELLED", "FAILED"]) assert.ok(!(campaignActionsFor(s) as string[]).includes("schedule"), s);
});

test("the wizard's send path is the server action only: no SMTP, queue, or dispatcher import in any client component", () => {
  for (const f of walk("src/features/admin/email-campaigns").filter((x) => x.endsWith(".tsx"))) {
    const src = code(f);
    assert.doesNotMatch(src, /sendSmtpMail|nodemailer|enqueueEmail|dispatchEmailCampaign|dispatchDueCampaigns|processEmailQueue|email-queue\.service|lib\/email\/smtp|fetch\(/, `${f}: nothing is sent from the browser`);
  }
});

// ------------------------------------------------------------------------------------------------------------------------------ 2. consent management

test("adding a contact never grants consent, with or without consent evidence being typed", async () => {
  const added: any = await adminCreateEmailContact(A, { email: "new@example.com", name: "New Person" }, { db: D(), now: NOW });
  assert.equal(added.ok, true); assert.equal(added.consent, "not_requested");
  const sneaky: any = await adminCreateEmailContact(A, { email: "sneaky@example.com", consentEvidence: EVIDENCE }, { db: D(), now: NOW });
  assert.equal(sneaky.ok, true); assert.equal(sneaky.consent, "not_requested");
  assert.equal(consentRows().length, 0);
  for (const e of ["new@example.com", "sneaky@example.com"]) { const v: any = await elig(e); assert.equal(v.eligible, false); assert.equal(v.reason, "no_consent"); }
  assert.equal(jobs().length, 0);
});

test("account creation, checkout progress and cart activity are not marketing consent: a customer contact with all of them is still not eligible", async () => {
  const r: any = await upsertEmailContact({ email: "c9@x.test", source: "CUSTOMER", userId: "cust-9", name: "Customer Nine" }, { db: D() });
  assert.ok(r.ok);
  db.insert("incompleteCheckout", { id: "ic-1", ownerKey: "user:cust-9", status: "ACTIVE", email: "c9@x.test", consentAt: new Date(T0.getTime() - 86_400_000) });
  const v: any = await elig("c9@x.test");
  assert.equal(v.eligible, false); assert.equal(v.reason, "no_consent");
  const detail: any = await adminGetEmailContactDetail(A, r.contact.id, { db: D(), now: NOW });
  assert.equal(detail.consentStatus, "none"); assert.equal(detail.consents.length, 0);
  assert.equal(consentRows().length, 0);
});

test("recording consent for an existing contact: server-fixed source and time, required evidence, history row, audit event, and the contact becomes eligible", async () => {
  const c = await contact("pat@example.com");
  assert.equal((await elig("pat@example.com") as any).eligible, false);
  const res: any = await adminRecordContactConsent(A, c.id, { evidence: EVIDENCE, attest: true }, { db: D(), now: NOW });
  assert.equal(res.ok, true, JSON.stringify(res)); assert.equal(res.outcome, "recorded");
  const rows = consentRows(c.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "ADMIN_RECORDED"); assert.equal(rows[0].evidence, EVIDENCE); assert.equal(rows[0].recordedById, A);
  assert.equal(rows[0].grantedAt.getTime(), NOW.getTime()); assert.equal(rows[0].unsubscribedAt ?? null, null);
  assert.equal((await elig("pat@example.com") as any).eligible, true);
  const audit = audits("email_contact.consent_record");
  assert.equal(audit.length, 1); assert.equal(audit[0].actorId, A); assert.equal(audit[0].entityId, c.id); assert.equal(audit[0].detail.outcome, "recorded");
  assert.ok(!JSON.stringify(audit).includes(EVIDENCE) && !JSON.stringify(audit).includes("pat@example.com"), "the audit event holds no evidence text or address");

  const again: any = await adminRecordContactConsent(A, c.id, { evidence: "A second, different piece of evidence", attest: true }, { db: D(), now: new Date(NOW.getTime() + 60_000) });
  assert.equal(again.ok, true); assert.equal(again.outcome, "already_on_file");
  assert.equal(consentRows(c.id).length, 1); assert.equal(consentRows(c.id)[0].evidence, EVIDENCE, "an open consent is never rewritten");
  assert.equal(jobs().length, 0, "recording consent sends and queues nothing");
});

test("recording consent is validated on the server: evidence and the attestation are required, and the browser cannot choose the source, the time or anything else", async () => {
  const c = await contact("pat@example.com");
  const bad: [string, unknown][] = [
    ["no input", {}], ["no attestation", { evidence: EVIDENCE }], ["attest false", { evidence: EVIDENCE, attest: false }], ["attest as text", { evidence: EVIDENCE, attest: "true" }],
    ["no evidence", { attest: true }], ["blank evidence", { evidence: "   ", attest: true }], ["too short", { evidence: "yes", attest: true }],
    ["too long", { evidence: "x".repeat(501), attest: true }], ["not text", { evidence: { a: 1 }, attest: true }],
  ];
  for (const [name, input] of bad) {
    const r: any = await adminRecordContactConsent(A, c.id, input as never, { db: D(), now: NOW });
    assert.equal(r.ok, false, name); assert.equal(r.code, "invalid_input", name);
  }
  assert.equal(consentRows().length, 0);
  const forged: any = await adminRecordContactConsent(A, c.id, { evidence: EVIDENCE, attest: true, source: "CHECKOUT_MARKETING", grantedAt: "2020-01-01T00:00:00Z", recordedById: "someone-else", unsubscribedAt: null } as never, { db: D(), now: NOW });
  assert.equal(forged.ok, true);
  const row = consentRows(c.id)[0];
  assert.equal(row.source, "ADMIN_RECORDED"); assert.equal(row.grantedAt.getTime(), NOW.getTime()); assert.equal(row.recordedById, A);
  const missing: any = await adminRecordContactConsent(A, "no-such-contact-id-1234567890", { evidence: EVIDENCE, attest: true }, { db: D(), now: NOW });
  assert.equal(missing.ok, false); assert.equal(missing.code, "not_found");
  const garbage: any = await adminRecordContactConsent(A, { $ne: 1 }, { evidence: EVIDENCE, attest: true }, { db: D(), now: NOW });
  assert.equal(garbage.code, "not_found");
});

test("recording a withdrawal ends the open consent, keeps its row, creates no suppression, and is idempotent", async () => {
  const c = await contact("pat@example.com");
  await adminRecordContactConsent(A, c.id, { evidence: EVIDENCE, attest: true }, { db: D(), now: T0 });
  const before = consentRows(c.id)[0];
  const later = new Date(NOW.getTime());
  const w: any = await adminWithdrawContactConsent(A, c.id, { note: "Replied to the Nov newsletter asking to stop" }, { db: D(), now: later });
  assert.equal(w.ok, true, JSON.stringify(w)); assert.equal(w.outcome, "withdrawn");
  const rows = consentRows(c.id);
  assert.equal(rows.length, 1, "the row is kept as history");
  assert.equal(rows[0].id, before.id); assert.equal(rows[0].source, "ADMIN_RECORDED"); assert.equal(rows[0].evidence, EVIDENCE); assert.equal(rows[0].grantedAt.getTime(), before.grantedAt.getTime());
  assert.equal(rows[0].unsubscribedAt.getTime(), later.getTime()); assert.equal(rows[0].unsubscribeSource, "ADMIN");
  assert.equal((await elig("pat@example.com") as any).reason, "no_consent");
  assert.equal(db.rows("emailSuppression").length, 0, "a withdrawal is not a suppression");
  const a = audits("email_contact.consent_withdraw");
  assert.equal(a.length, 1); assert.equal(a[0].detail.outcome, "withdrawn"); assert.equal(a[0].detail.note, "Replied to the Nov newsletter asking to stop");

  const again: any = await adminWithdrawContactConsent(A, c.id, {}, { db: D(), now: new Date(later.getTime() + 1000) });
  assert.equal(again.ok, true); assert.equal(again.outcome, "nothing_to_withdraw");
  assert.equal(consentRows(c.id)[0].unsubscribedAt.getTime(), later.getTime(), "the end time is not moved");
  const longNote: any = await adminWithdrawContactConsent(A, c.id, { note: "x".repeat(501) }, { db: D(), now: later });
  assert.equal(longNote.ok, false); assert.equal(longNote.field, "note");
});

test("consent history is append-only: grant, withdraw, grant again, withdraw again keeps every row and never rewrites an ended one", async () => {
  const c = await contact("pat@example.com");
  const t = (m: number) => new Date(T0.getTime() + m * 60_000);
  await adminRecordContactConsent(A, c.id, { evidence: "First opt-in recorded from the paper form", attest: true }, { db: D(), now: t(1) });
  await adminWithdrawContactConsent(A, c.id, {}, { db: D(), now: t(2) });
  const firstClosed = JSON.stringify(consentRows(c.id)[0]);
  const second: any = await adminRecordContactConsent(A, c.id, { evidence: "Second opt-in: the person asked again by phone", attest: true }, { db: D(), now: t(3) });
  assert.equal(second.outcome, "recorded");
  assert.equal(consentRows(c.id).length, 2, "a new opt-in is a NEW row");
  assert.equal(JSON.stringify(consentRows(c.id).find((r) => r.id === JSON.parse(firstClosed).id)), firstClosed, "the ended row is untouched");
  await adminWithdrawContactConsent(A, c.id, {}, { db: D(), now: t(4) });
  const rows = consentRows(c.id).sort((a, b) => a.grantedAt - b.grantedAt);
  assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.unsubscribedAt && r.unsubscribeSource === "ADMIN"));
  assert.deepEqual(rows.map((r) => r.evidence), ["First opt-in recorded from the paper form", "Second opt-in: the person asked again by phone"]);
  const detail: any = await adminGetEmailContactDetail(A, c.id, { db: D(), now: NOW });
  assert.equal(detail.consents.length, 2); assert.equal(detail.consentStatus, "withdrawn");
  assert.equal(db.rows("marketingConsent").length, 2, "nothing was ever deleted");
});

test("the admin consent screen cannot make a suppressed contact eligible: unsubscribed, bounced, complained and admin-blocked are all refused and left exactly as they were", async () => {
  for (const reason of ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "ADMIN"] as const) {
    const email = `${reason.toLowerCase()}@example.com`;
    const c = await contact(email, { suppress: reason });
    const supBefore = JSON.stringify(db.rows("emailSuppression").find((s) => s.email === email));
    const r: any = await adminRecordContactConsent(A, c.id, { evidence: EVIDENCE, attest: true }, { db: D(), now: NOW });
    assert.equal(r.ok, false, reason); assert.equal(r.code, "blocked_suppressed", reason);
    assert.equal(consentRows(c.id).length, 0, `${reason}: no consent row is left behind`);
    assert.equal(JSON.stringify(db.rows("emailSuppression").find((s) => s.email === email)), supBefore, `${reason}: the suppression is untouched`);
    assert.equal(db.rows("emailSuppression").find((s) => s.email === email).liftedAt ?? null, null);
    const v: any = await elig(email);
    assert.equal(v.eligible, false, reason); assert.equal(v.reason, "suppressed", reason);
    const viaAction: any = await runAs("admin", () => recordEmailContactConsentAction(c.id, { evidence: EVIDENCE, attest: true }) as never);
    assert.equal(viaAction.success, false); assert.equal(viaAction.code, "blocked_suppressed");
  }
  assert.equal(audits("email_contact.consent_record_refused").length, 8, "every refused attempt is audited");
  assert.equal(jobs().length, 0);
});

test("an inactive contact is refused, and a withdrawal never touches a suppression", async () => {
  const inactive = await contact("off@example.com", { inactive: true });
  const r: any = await adminRecordContactConsent(A, inactive.id, { evidence: EVIDENCE, attest: true }, { db: D(), now: NOW });
  assert.equal(r.ok, false); assert.equal(r.code, "blocked_inactive"); assert.equal(consentRows(inactive.id).length, 0);

  const bounced = await contact("bounced@example.com", { suppress: "BOUNCED" });
  const supBefore = JSON.stringify(db.rows("emailSuppression"));
  const w: any = await adminWithdrawContactConsent(A, bounced.id, {}, { db: D(), now: NOW });
  assert.equal(w.ok, true); assert.equal(w.outcome, "nothing_to_withdraw");
  assert.equal(JSON.stringify(db.rows("emailSuppression")), supBefore);
});

test("consent actions are for admins only and write nothing for anyone else", async () => {
  const c = await contact("pat@example.com", { consent: true });
  const snapshot = () => JSON.stringify({ k: db.rows("marketingConsent"), s: db.rows("emailSuppression"), a: db.rows("adminAuditEvent") });
  const before = snapshot();
  for (const who of ["cust-9", "adm-off", null, undefined, "nobody"]) {
    await assert.rejects(adminRecordContactConsent(who, c.id, { evidence: EVIDENCE, attest: true }, { db: D(), now: NOW }), undefined, `record: ${String(who)}`);
    await assert.rejects(adminWithdrawContactConsent(who, c.id, {}, { db: D(), now: NOW }), undefined, `withdraw: ${String(who)}`);
  }
  await assert.rejects(runAs(null, () => recordEmailContactConsentAction(c.id, { evidence: EVIDENCE, attest: true }) as never), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "cust-9" }, () => recordEmailContactConsentAction(c.id, { evidence: EVIDENCE, attest: true }) as never), /FORBIDDEN/);
  await assert.rejects(runAs(null, () => withdrawEmailContactConsentAction(c.id) as never), /FORBIDDEN/);
  await assert.rejects(runAs({ sub: "cust-9" }, () => withdrawEmailContactConsentAction(c.id) as never), /FORBIDDEN/);
  assert.equal(snapshot(), before);
  const ok: any = await runAs("admin", () => withdrawEmailContactConsentAction(c.id, { note: "per phone call" }) as never);
  assert.equal(ok.success, true); assert.equal(ok.outcome, "withdrawn");
});

test("the consent UI is wired and has nothing that could lift a suppression or send mail (source check, not a browser test)", () => {
  const panel = code("src/features/admin/email-contacts/contact-consent-panel.tsx");
  assert.match(panel, /recordEmailContactConsentAction/); assert.match(panel, /withdrawEmailContactConsentAction/);
  assert.doesNotMatch(panel, /unsuppress|removeSuppression|liftSuppression|emailSuppression|sendSmtpMail|enqueueEmail|email-queue|fetch\(/i);
  assert.match(read("src/app/admin/(dashboard)/email-marketing/contacts/[id]/page.tsx"), /<ContactConsentPanel contactId=\{c\.id\}/);
  assert.match(read("src/features/admin/email-contacts/add-contact-dialog.tsx"), /manage its marketing consent/);
  const actions = read("src/server/actions/admin-email-contact.actions.ts");
  for (const name of ["recordEmailContactConsentAction", "withdrawEmailContactConsentAction"]) {
    assert.match(actions.slice(actions.indexOf(`export async function ${name}`)).split("\n").slice(0, 3).join("\n"), /requireAdmin\(\)/, `${name} calls requireAdmin first`);
  }
  const service = code("src/server/services/email-contact-admin.service.ts");
  const recordFn = service.slice(service.indexOf("export async function adminRecordContactConsent"), service.indexOf("export async function adminWithdrawContactConsent"));
  assert.match(recordFn, /neverLiftSuppression: true/); assert.match(recordFn, /recordMarketingConsent\(/);
  assert.doesNotMatch(recordFn, /marketingConsent\.(create|update|delete)|emailSuppression\.(create|update|delete)|liftedAt/, "reuses the P08 consent service; no parallel writes");
});

// ------------------------------------------------------------------------------------------------------------------------------ 3. marketing needs consent

test("a marketing campaign cannot reach a contact without valid consent, even if a recipient row for them is forced into the audience", async () => {
  const id = await draftWithAudience(["ok@example.com"]);
  const noConsent = await contact("none@example.com");
  const checkoutOnly = await contact("checkout@example.com");
  db.insert("incompleteCheckout", { id: "ic-2", ownerKey: "guest:x", status: "ACTIVE", email: "checkout@example.com", consentAt: new Date(T0.getTime() - 3_600_000) });
  const future = await contact("future@example.com");
  await (db as any).marketingConsent.create({ data: { contactId: future.id, source: "ADMIN_RECORDED", grantedAt: new Date(NOW.getTime() + 86_400_000) } });
  const bounced = await contact("bounced@example.com", { consent: true, suppress: "BOUNCED" });
  const inactive = await contact("inactive@example.com", { consent: true, inactive: true });
  for (const x of [noConsent, checkoutOnly, future, bounced, inactive]) await (db as any).emailCampaignRecipient.create({ data: { campaignId: id, contactId: x.id, status: "PENDING" } });

  const res = await send(id);
  assert.equal(res.ok, true, JSON.stringify(res)); assert.equal(res.enqueued, 1); assert.equal(res.skipped, 5);
  assert.deepEqual(jobs().map((j) => j.toEmail), ["ok@example.com"]);
  const byContact = (cid: string) => recipients(id).find((r) => r.contactId === cid);
  assert.equal(byContact(noConsent.id).skipReason, "no_consent");
  assert.equal(byContact(checkoutOnly.id).skipReason, "no_consent", "checkout progress consent is not marketing consent");
  assert.equal(byContact(future.id).skipReason, "no_consent", "a consent that is not yet in effect is not valid");
  assert.equal(byContact(bounced.id).skipReason, "suppressed");
  assert.equal(byContact(inactive.id).skipReason, "inactive");
  await processEmailQueue({ db: D(), env: SMTP_ENV, factory: smtp.factory, now: NOW });
  assert.deepEqual(smtp.mails.map((m) => m.to), ["ok@example.com"]);
});

test("the audience preparation behind send now never adds a contact without valid consent", async () => {
  await optedIn(db, "ok@example.com");
  await contact("none@example.com");
  await contact("sup@example.com", { consent: true, suppress: "UNSUBSCRIBED" });
  const saved: any = await adminSaveCampaignDraft(A, { name: "Mixed", templateId: await template() }, { db: D() });
  const prep: any = await adminPrepareCampaignAudience(A, saved.id, {}, { db: D(), now: NOW });
  assert.equal(prep.ok, true); assert.equal(prep.audience.eligible, 1);
  assert.deepEqual(recipients(saved.id).map((r) => r.status), ["PENDING"]);
});

// ------------------------------------------------------------------------------------------------------------------------------ 3b. marketing vs transactional: what the architecture supports

test("transactional-purpose sending is NOT supported by the existing architecture, so none was added: the queue has no purpose or lawful-basis field", () => {
  const schema = read("prisma/schema.prisma");
  const job = schema.slice(schema.indexOf("model EmailJob {"), schema.indexOf("}", schema.indexOf("model EmailJob {")));
  assert.doesNotMatch(job, /purpose|lawful|basis|transactional\s+Boolean|isTransactional/i, "EmailJob has no purpose classification: `kind` is a free-text label and `priority` is only drain order");
  const migrations = walk("prisma/migrations").map((f) => read(f)).join("\n");
  assert.doesNotMatch(migrations, /lawfulBasis|emailPurpose|EmailPurpose/i);
  const rules = code("src/lib/email/queue-policy.ts");
  assert.match(rules, /EMAIL_PRIORITY = \{ transactional: 0, bulk: 1 \}/, "the only 'transactional' in the queue is a drain-order number, not an authorisation");
});

test("only the existing campaign dispatcher can enqueue; the ONLY direct SMTP callers are the queue worker, the two fixed admin test e-mails and the SMTP module itself", () => {
  const src = walk("src").filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => f.replaceAll("\\", "/"));
  const callers = src.filter((f) => !f.endsWith("email-queue.service.ts")).filter((f) => /\benqueueEmails?\s*\(/.test(code(f)));
  // The campaign dispatcher, and the admin-triggered abandoned-cart sender (it re-checks marketing eligibility and the unsubscribe link itself before queuing, and the worker gates it again before SMTP).
  assert.deepEqual(callers, ["src/server/services/abandoned-cart-email.service.ts", "src/server/services/email-campaign-dispatch.service.ts"], "only the campaign dispatcher and the admin-triggered abandoned-cart sender call the queue");
  const senders = src.filter((f) => /\bsendSmtpMail\s*\(/.test(code(f))).sort();
  assert.deepEqual(senders, [
    "src/lib/email/smtp.ts", // the SMTP module itself
    "src/server/services/admin-smtp.service.ts", // admin SMTP test e-mail: fixed text, one typed recipient
    "src/server/services/email-queue.service.ts", // the worker: campaign jobs pass the marketing gate first
    "src/server/services/email-template-designer.service.ts", // admin "[TEST]" e-mail of a template with SAMPLE data (reported: it does not consult suppression)
  ]);
  assert.equal(src.filter((f) => f.includes("/features/") || f.includes("/app/") || f.includes("/components/")).filter((f) => /sendSmtpMail|enqueueEmail/.test(code(f))).length, 0, "no page or client component sends");
});

test("there is no consent bypass: no override, force, skip or transactional switch exists anywhere in the email marketing code", () => {
  const files = [...walk("src/server/services"), ...walk("src/server/actions"), ...walk("src/lib/email"), ...walk("src/features/admin")]
    .filter((f) => /\.(ts|tsx)$/.test(f) && /email|campaign|contact|consent|suppress|marketing/i.test(f));
  assert.ok(files.length > 20);
  for (const f of files) {
    assert.doesNotMatch(code(f), /bypass|skipConsent|ignoreConsent|ignoreSuppression|overrideConsent|overrideSuppression|forceSend|sendAnyway|isTransactional|transactional\s*:\s*true|purpose\s*:\s*["']transactional/i, `${f}: no consent bypass or transactional switch`);
  }
});

test("a campaign cannot be turned into a 'transactional' message: purpose-like fields are not accepted, and the message always goes out as a gated campaign job", async () => {
  await optedIn(db, "a@example.com");
  const saved: any = await adminSaveCampaignDraft(A, { name: "Disguised", templateId: await template(), purpose: "TRANSACTIONAL", transactional: true, kind: "order-confirmation", lawfulBasis: "contract", skipConsent: true } as never, { db: D() });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const row = campaigns().find((c) => c.id === saved.id);
  for (const k of ["purpose", "transactional", "kind", "lawfulBasis", "skipConsent"]) assert.ok(!(k in row), `the campaign row has no ${k}`);
  assert.equal((await adminPrepareCampaignAudience(A, saved.id, {}, { db: D(), now: T0 }) as any).ok, true);
  await contact("none@example.com"); // no consent: must not be reachable by any label
  await (db as any).emailCampaignRecipient.create({ data: { campaignId: saved.id, contactId: contacts().find((c) => c.email === "none@example.com").id, status: "PENDING" } });
  const res = await send(saved.id);
  assert.equal(res.ok, true); assert.equal(res.enqueued, 1);
  assert.ok(jobs().every((j) => j.kind === "campaign"), "campaign content only ever travels as the gated campaign kind");
  assert.deepEqual(jobs().map((j) => j.toEmail), ["a@example.com"]);
});

test("promotional campaign content cannot enter a non-campaign path: every campaign message is built with the campaign kind and its own unsubscribe link", async () => {
  const id = await draftWithAudience(["a@example.com"]);
  db.patch("emailCampaign", id, { subject: "20% OFF everything today", textBody: "Big discount! Shop now and save. Unsubscribe: {{unsubscribeUrl}}", htmlBody: '<p>Recommended for you</p><a href="{{unsubscribeUrl}}">Unsubscribe</a>' });
  assert.equal((await send(id)).ok, true);
  const [job] = jobs();
  assert.equal(job.kind, "campaign"); assert.equal(job.priority, 1);
  assert.match(job.subject, /20% OFF/);
  assert.match(job.text, /\/unsubscribe\//);
  const dispatcher = code("src/server/services/email-campaign-dispatch.service.ts");
  assert.doesNotMatch(dispatcher, /kind:\s*["'](?!campaign)/, "the dispatcher never labels a campaign message with another kind");
  assert.match(code("src/lib/email/campaign-dispatch-rules.ts"), /kind: CAMPAIGN_JOB_KIND/);
});
