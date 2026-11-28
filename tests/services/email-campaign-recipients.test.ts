/* eslint-disable @typescript-eslint/no-explicit-any */
/** Prompt 09: campaign audience preparation on the in-memory database, using the REAL P08 eligibility, consent and suppression services. */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { prepareCampaignRecipients } from "@/server/services/email-campaign-recipient.service";
import { suppressEmail, } from "@/server/services/email-suppression.service";
import { unsubscribeEmail } from "@/server/services/email-unsubscribe.service";
import { recordMarketingConsent, withdrawMarketingConsent } from "@/server/services/marketing-consent.service";
import { upsertEmailContact } from "@/server/services/email-contact.service";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";

let db: FakeDb;
const NOW = new Date("2026-11-25T10:00:00.000Z");
beforeEach(() => { db = freshDb(); });
const D = () => db as never;

async function optedIn(email: string, over: Record<string, unknown> = {}) {
  const c = await (db as any).emailContact.create({ data: { email, source: "MANUAL", ...over } });
  const consent = await (db as any).marketingConsent.create({ data: { contactId: c.id, source: "ADMIN_RECORDED", grantedAt: new Date(NOW.getTime() - 86_400_000) } });
  return { contact: c, consent };
}
async function campaign(over: Record<string, unknown> = {}) {
  return (db as any).emailCampaign.create({ data: { name: "C", subject: "s", textBody: "b", ...over } });
}
const prep = (id: string, input: any = {}, opts: any = {}) => prepareCampaignRecipients(id, input, { db: D(), now: NOW, ...opts }) as Promise<any>;
const recipients = (campaignId?: string) => db.rows("emailCampaignRecipient").filter((r) => !campaignId || r.campaignId === campaignId);

test("only eligible contacts become recipients, each as a PENDING snapshot row carrying the consent that allowed it", async () => {
  const a = await optedIn("a@example.com");
  const b = await optedIn("b@example.com");
  await (db as any).emailContact.create({ data: { email: "noconsent@example.com", source: "MANUAL" } });
  const c = await campaign();
  const r = await prep(c.id);
  assert.ok(r.ok);
  assert.deepEqual([r.added, r.recipientCount, r.excluded.no_consent], [2, 2, 1]);
  const rows = recipients(c.id);
  assert.deepEqual(rows.map((x) => x.contactId).sort(), [a.contact.id, b.contact.id].sort());
  for (const row of rows) {
    assert.equal(row.status, "PENDING");
    assert.equal(row.skipReason, null);
    assert.equal(row.emailJobId, null);
    assert.equal(row.consentId, row.contactId === a.contact.id ? a.consent.id : b.consent.id);
  }
  assert.equal(db.rows("emailCampaign")[0].recipientCount, 2);
});

test("unsubscribed, suppressed, bounced, complained, inactive, consent-withdrawn and consent-less contacts are excluded; counts use the fixed vocabulary", async () => {
  const ok = await optedIn("ok@example.com");
  await optedIn("unsub@example.com");
  await optedIn("manual@example.com");
  await optedIn("bounce@example.com");
  await optedIn("complain@example.com");
  await optedIn("inactive@example.com", { isActive: false });
  const wd = await optedIn("withdrawn@example.com");
  await unsubscribeEmail("unsub@example.com", "LINK", { db: D(), now: NOW });
  await suppressEmail("manual@example.com", { reason: "ADMIN" }, { db: D(), now: NOW });
  await suppressEmail("bounce@example.com", { reason: "BOUNCED" }, { db: D(), now: NOW });
  await suppressEmail("complain@example.com", { reason: "COMPLAINED" }, { db: D(), now: NOW });
  await withdrawMarketingConsent(wd.contact.id, "ADMIN", { db: D(), now: NOW });
  // suppressed address that has NO open consent row at all, and a suppression written directly (consent row still open)
  await optedIn("direct@example.com");
  await (db as any).emailSuppression.create({ data: { email: "direct@example.com", reason: "UNSUBSCRIBED" } });

  const c = await campaign();
  const r = await prep(c.id);
  assert.deepEqual(recipients(c.id).map((x) => x.contactId), [ok.contact.id]);
  assert.deepEqual(r.excluded, { invalid_email: 0, no_contact: 0, suppressed: 5, inactive: 0, no_consent: 1, unverifiable: 0 }, "inactive contacts are not even scanned");
  assert.equal(r.added, 1);
  assert.ok(!JSON.stringify(r).includes("example.com"), "the result carries no addresses");
  assert.ok(!/BOUNCED|COMPLAINED|UNSUBSCRIBED/.test(JSON.stringify(r)), "the result carries no suppression reasons");
});

test("eligibility that cannot be verified excludes the contact (fail closed), whether the check reports it or throws", async () => {
  await optedIn("a@example.com");
  const c = await campaign();
  const orig = (db as any).delegate.bind(db);
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailSuppression") d.findFirst = async () => { throw new Error("db down"); };
    return d;
  };
  const r = await prep(c.id);
  delete (db as any).delegate;
  assert.ok(r.ok);
  assert.deepEqual([r.added, r.excluded.unverifiable], [0, 1]);
  assert.equal(recipients().length, 0);
  // a non-boolean isActive is unreadable -> unverifiable
  await (db as any).emailContact.update({ where: { id: db.rows("emailContact")[0].id }, data: { isActive: "yes" } });
  const r2 = await prep(c.id, { contactIds: [db.rows("emailContact")[0].id] });
  assert.equal(r2.excluded.unverifiable, 1);
  assert.equal(recipients().length, 0);
});

test("client-provided eligibility is ignored: naming an ineligible contact, or adding eligibility-looking fields, adds nothing", async () => {
  const bad = await optedIn("bad@example.com");
  await unsubscribeEmail("bad@example.com", "LINK", { db: D(), now: NOW });
  const c = await campaign();
  const r = await prep(c.id, { contactIds: [bad.contact.id, "does-not-exist"], eligible: true, consent: true, status: "SENT", skipEligibility: true });
  assert.ok(r.ok);
  assert.equal(r.added, 0);
  assert.deepEqual([r.excluded.suppressed, r.excluded.no_contact], [1, 1]);
  assert.equal(recipients().length, 0);
});

test("explicit contactIds limit the audience; duplicate ids in the input do not duplicate recipients", async () => {
  const a = await optedIn("a@example.com");
  await optedIn("b@example.com");
  const c = await campaign();
  const r = await prep(c.id, { contactIds: [a.contact.id, a.contact.id, a.contact.id] });
  assert.deepEqual([r.added, r.recipientCount], [1, 1]);
  assert.deepEqual(recipients().map((x) => x.contactId), [a.contact.id]);
});

test("invalid input and campaigns that are not drafts are refused without writing", async () => {
  await optedIn("a@example.com");
  const c = await campaign();
  for (const bad of [{ contactIds: "x" }, { contactIds: [1] }, { contactIds: ["a b"] }, { contactIds: Array(10_001).fill("x") }]) assert.equal((await prep(c.id, bad)).reason, "invalid_input", JSON.stringify(bad).slice(0, 40));
  assert.equal((await prep("missing")).reason, "not_found");
  assert.equal((await prep(42 as never)).reason, "not_found");
  for (const status of ["SCHEDULED", "SENDING", "COMPLETED", "CANCELLED", "FAILED"]) {
    const x = await campaign({ name: status, status, scheduledAt: status === "SCHEDULED" ? NOW : null, completedAt: status === "COMPLETED" ? NOW : null });
    assert.equal((await prep(x.id)).reason, "not_editable", status);
  }
  assert.equal(recipients().length, 0);
});

test("repeating preparation never duplicates recipients: the second run adds nothing and reports them as already prepared", async () => {
  for (let i = 0; i < 5; i++) await optedIn(`u${i}@example.com`);
  const c = await campaign();
  const first = await prep(c.id, {}, { chunkSize: 2 });
  const second = await prep(c.id, {}, { chunkSize: 2 });
  const third = await prep(c.id);
  assert.deepEqual([first.added, first.recipientCount], [5, 5]);
  assert.deepEqual([second.added, second.alreadyPrepared, second.considered, second.recipientCount], [0, 5, 0, 5]);
  assert.deepEqual([third.added, third.alreadyPrepared], [0, 5]);
  assert.equal(recipients().length, 5);
  assert.equal(new Set(recipients().map((r) => r.contactId)).size, 5);
  assert.equal(db.rows("emailCampaign")[0].recipientCount, 5);
});

test("a re-run picks up newly eligible contacts and adds only those; other campaigns keep their own audience", async () => {
  await optedIn("a@example.com");
  const c1 = await campaign({ name: "One" });
  const c2 = await campaign({ name: "Two" });
  await prep(c1.id);
  const late = await optedIn("late@example.com");
  const r = await prep(c1.id);
  assert.deepEqual([r.added, r.alreadyPrepared, r.recipientCount], [1, 1, 2]);
  assert.equal(recipients(c2.id).length, 0);
  await prep(c2.id);
  assert.equal(recipients(c2.id).length, 2, "the same contact can be a recipient of a different campaign");
  assert.ok(recipients(c1.id).some((x) => x.contactId === late.contact.id));
});

test("a re-run re-checks existing PENDING recipients: no longer eligible -> SKIPPED with a fixed reason (history kept); counts follow; no duplicates", async () => {
  const keep = await optedIn("keep@example.com");
  const gone = await optedIn("gone@example.com");
  const c = await campaign();
  await prep(c.id);
  await unsubscribeEmail("gone@example.com", "LINK", { db: D(), now: NOW });
  const r = await prep(c.id);
  assert.deepEqual([r.skippedNow, r.added, r.recipientCount], [1, 0, 2]);
  const rows = recipients(c.id);
  assert.equal(rows.length, 2, "the row is kept");
  const goneRow = rows.find((x) => x.contactId === gone.contact.id)!;
  assert.deepEqual([goneRow.status, goneRow.skipReason], ["SKIPPED", "suppressed"]);
  assert.equal(rows.find((x) => x.contactId === keep.contact.id)!.status, "PENDING");
  assert.equal(db.rows("emailCampaign")[0].skippedCount, 1);
  const again = await prep(c.id);
  assert.deepEqual([again.skippedNow, again.recipientCount], [0, 2], "a SKIPPED row is not touched again");
  // renewed consent after a withdrawal: a still-PENDING row keeps the consent reference it was prepared with (nothing is rewritten)
  const re = await optedIn("renew@example.com");
  await prep(c.id);
  const originalConsentId = recipients(c.id).find((x) => x.contactId === re.contact.id)!.consentId;
  assert.equal(originalConsentId, re.consent.id);
  await withdrawMarketingConsent(re.contact.id, "ADMIN", { db: D(), now: NOW });
  const renewed = await recordMarketingConsent(re.contact.id, { source: "SIGNUP_FORM" }, { db: D(), now: NOW });
  assert.ok(renewed.ok);
  await prep(c.id);
  const kept = recipients(c.id).find((x) => x.contactId === re.contact.id)!;
  assert.deepEqual([kept.status, kept.consentId], ["PENDING", originalConsentId]);
});

test("rows that are already QUEUED/SENT/FAILED are never rewritten by a re-run", async () => {
  const a = await optedIn("a@example.com");
  const c = await campaign();
  await prep(c.id);
  await (db as any).emailCampaignRecipient.update({ where: { id: recipients()[0].id }, data: { status: "SENT", sentAt: NOW } });
  await unsubscribeEmail("a@example.com", "LINK", { db: D(), now: NOW });
  const r = await prep(c.id);
  assert.deepEqual([r.skippedNow, r.alreadyPrepared], [0, 1]);
  assert.equal(recipients()[0].status, "SENT");
  assert.equal(recipients()[0].contactId, a.contact.id);
});

test("a failing chunk rolls back that chunk only, throws, and a re-run completes the audience without duplicates", async () => {
  for (let i = 0; i < 5; i++) await optedIn(`u${i}@example.com`);
  const c = await campaign();
  const orig = (db as any).delegate.bind(db);
  let calls = 0;
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailCampaignRecipient") {
      const cm = d.createMany.bind(d);
      d.createMany = async (a: any) => { calls++; if (calls === 2) { await cm({ ...a, data: a.data.slice(0, 1) }); throw new Error("disk full"); } return cm(a); };
    }
    return d;
  };
  await assert.rejects(prep(c.id, {}, { chunkSize: 2 }), /disk full/);
  delete (db as any).delegate;
  assert.equal(recipients().length, 2, "chunk 1 committed; chunk 2 (including its partial insert) rolled back");
  assert.equal(db.rows("emailCampaign")[0].recipientCount, 0, "the count is only written when the run finishes");
  const r = await prep(c.id, {}, { chunkSize: 2 });
  assert.deepEqual([r.added, r.alreadyPrepared, r.recipientCount], [3, 2, 5]);
  assert.equal(new Set(recipients().map((x) => x.contactId)).size, 5);
});

test("concurrent preparation of the same campaign creates each recipient exactly once", async () => {
  for (let i = 0; i < 6; i++) await optedIn(`u${i}@example.com`);
  const c = await campaign();
  const results = await Promise.all(Array.from({ length: 4 }, () => prep(c.id, {}, { chunkSize: 2 })));
  assert.ok(results.every((r) => r.ok));
  assert.equal(results.reduce((n, r) => n + r.added, 0), 6);
  assert.equal(recipients().length, 6);
  assert.equal(new Set(recipients().map((x) => x.contactId)).size, 6);
});

test("a unique-constraint conflict inside createMany (a concurrent insert) is absorbed, not duplicated or thrown", async () => {
  const a = await optedIn("a@example.com");
  const c = await campaign();
  const orig = (db as any).delegate.bind(db);
  let injected = false;
  (db as any).delegate = (t: string) => {
    const d = orig(t);
    if (t === "emailCampaignRecipient") {
      const cm = d.createMany.bind(d);
      d.createMany = async (x: any) => { if (!injected) { injected = true; await d.create({ data: { campaignId: c.id, contactId: a.contact.id, consentId: a.consent.id } }); } return cm(x); };
    }
    return d;
  };
  const r = await prep(c.id);
  delete (db as any).delegate;
  assert.deepEqual([r.ok, r.added, r.alreadyPrepared, r.recipientCount], [true, 0, 1, 1]);
  assert.equal(recipients().length, 1);
});

test("a campaign that stops being a draft mid-run is not changed further", async () => {
  await optedIn("a@example.com");
  const c = await campaign();
  const origTx = (db as any).$transaction.bind(db);
  let fired = false;
  // another request cancels the campaign (committed) just before this run's first chunk transaction starts
  (db as any).$transaction = async (...args: any[]) => {
    if (!fired) { fired = true; await (db as any).emailCampaign.update({ where: { id: c.id }, data: { status: "CANCELLED", cancelledAt: NOW } }); }
    return origTx(...args);
  };
  const r = await prep(c.id);
  delete (db as any).$transaction;
  assert.equal(r.reason, "not_editable");
  assert.equal(recipients().length, 0);
  assert.equal(db.rows("emailCampaign")[0].status, "CANCELLED");
});

test("preparation never sends or queues: no EmailJob, and contacts, consents and suppressions are untouched", async () => {
  await optedIn("a@example.com");
  await optedIn("b@example.com");
  await unsubscribeEmail("b@example.com", "LINK", { db: D(), now: NOW });
  const snap = () => JSON.stringify([db.rows("emailContact"), db.rows("marketingConsent"), db.rows("emailSuppression")]);
  const before = snap();
  const c = await campaign();
  await prep(c.id);
  await prep(c.id);
  assert.equal(db.rows("emailJob").length, 0);
  assert.equal(snap(), before);
  assert.ok(recipients().every((r) => r.emailJobId === null && r.queuedAt === null && r.sentAt === null));
});

test("a consent from the checkout 'save my progress' tick (IncompleteCheckout.consentAt) never makes a contact a recipient", async () => {
  await (db as any).emailContact.create({ data: { email: "cart@example.com", source: "MANUAL" } });
  db.insert("incompleteCheckout", { email: "cart@example.com", consentAt: NOW });
  const c = await campaign();
  const r = await prep(c.id);
  assert.deepEqual([r.added, r.excluded.no_consent], [0, 1]);
});

test("the audience matches the P08 eligibility service exactly (same verdict for every contact)", async () => {
  await optedIn("a@example.com");
  await optedIn("b@example.com");
  await unsubscribeEmail("b@example.com", "LINK", { db: D(), now: NOW });
  await upsertEmailContact({ email: "c@example.com", source: "MANUAL" }, { db: D() });
  const c = await campaign();
  await prep(c.id);
  for (const contact of db.rows("emailContact")) {
    const verdict = await getMarketingEligibility(contact.email, { db: D(), now: NOW });
    assert.equal(recipients(c.id).some((r) => r.contactId === contact.id), verdict.eligible, contact.email);
  }
});

test("re-check is non-destructive and idempotent: the SKIPPED row keeps its id and consent reference, no row is deleted, and contacts, consents and suppressions are not rewritten", async () => {
  const stay = await optedIn("stay@example.com");
  const leave = await optedIn("leave@example.com");
  const c = await campaign();
  await prep(c.id);
  const before = recipients(c.id).find((x) => x.contactId === leave.contact.id)!;
  await unsubscribeEmail("leave@example.com", "LINK", { db: D(), now: NOW });
  const otherTables = () => JSON.stringify([db.rows("emailContact"), db.rows("marketingConsent"), db.rows("emailSuppression")]);
  const frozen = otherTables(); // after the unsubscribe itself, so only the re-check could change anything from here
  const campaignBefore = db.rows("emailCampaign")[0];

  const runs = [await prep(c.id), await prep(c.id), await prep(c.id, {}, { chunkSize: 1 })];
  const after = recipients(c.id);
  assert.equal(after.length, 2, "no recipient row was deleted or added");
  const skipped = after.find((x) => x.id === before.id)!;
  assert.deepEqual([skipped.status, skipped.skipReason, skipped.contactId, skipped.consentId, skipped.createdAt.getTime()], ["SKIPPED", "suppressed", leave.contact.id, before.consentId, before.createdAt.getTime()]);
  assert.equal(after.find((x) => x.contactId === stay.contact.id)!.status, "PENDING");
  assert.deepEqual(runs.map((r) => r.skippedNow), [1, 0, 0], "only the first run changes anything; repeats are no-ops");
  assert.deepEqual(runs.map((r) => r.recipientCount), [2, 2, 2]);
  assert.equal(otherTables(), frozen, "no contact, consent or suppression row was touched");
  const campaignAfter = db.rows("emailCampaign")[0];
  assert.deepEqual([campaignAfter.name, campaignAfter.subject, campaignAfter.textBody, campaignAfter.status, campaignAfter.createdAt.getTime()], [campaignBefore.name, campaignBefore.subject, campaignBefore.textBody, "DRAFT", campaignBefore.createdAt.getTime()]);
  assert.deepEqual([campaignAfter.recipientCount, campaignAfter.skippedCount, campaignAfter.sentCount, campaignAfter.failedCount], [2, 1, 0, 0]);
  assert.equal(db.rows("emailJob").length, 0);
});
