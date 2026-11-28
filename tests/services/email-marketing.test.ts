/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prompt 07 on the in-memory database. The fake mirrors the migration's UNIQUE and partial-unique indexes (tests/setup/fake-db.ts), so these
 * tests prove the application-level behaviour built on them (and that existing e-mail code is unaffected). That the REAL database enforces the same
 * constraints (plus the CHECKs and foreign keys) is covered by tests/integration/email-marketing.postgres.test.ts, which needs TEST_DATABASE_URL.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { enqueueEmail, processEmailQueue } from "@/server/services/email-queue.service";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { getContactUnsubscribeLink } from "@/server/services/email-unsubscribe.service";
import { abandonedCartEventKey, generateUnsubscribeToken, incompleteCheckoutEventKey, normalizeContactEmail } from "@/lib/email/marketing";

let db: FakeDb;
const T0 = new Date("2026-11-22T10:00:00.000Z");
const realLog = { warn: console.warn, info: console.info, error: console.error };
beforeEach(() => { db = freshDb(); discardAfter(); console.warn = console.info = console.error = () => {}; });
afterEach(() => { Object.assign(console, realLog); });

const p2002 = { code: "P2002" };
const nowDb = () => db as never;

async function contact(email: string, over: Record<string, unknown> = {}) {
  const n = normalizeContactEmail(email);
  assert.ok(n.ok);
  return db.emailContact.create({ data: { email: n.email, source: "MANUAL", ...over } });
}
const grant = (contactId: string, over: Record<string, unknown> = {}) =>
  db.marketingConsent.create({ data: { contactId, source: "ADMIN_RECORDED", grantedAt: T0, ...over } });

// ------------------------------------------------------------------------------------------------------------------------------- contacts

test("a contact e-mail is unique, and addresses that normalise to the same form are the same contact", async () => {
  await contact("Jane@Example.com");
  await assert.rejects(contact("jane@example.com"), p2002);
  await assert.rejects(contact("  JANE@EXAMPLE.COM "), p2002);
  await contact("jane2@example.com"); // a different address is fine
  assert.equal(db.rows("emailContact").length, 2);
  assert.equal(db.rows("emailContact")[0].email, "jane@example.com", "stored normalised");
});

test("contacts record their source, default to active, and a customer contact keeps its link to the user", async () => {
  const manual = await contact("a@example.com");
  const csv = await contact("b@example.com", { source: "CSV_IMPORT", name: "Bee" });
  const cust = await contact("c@example.com", { source: "CUSTOMER", userId: "u1" });
  assert.deepEqual([manual.source, csv.source, cust.source], ["MANUAL", "CSV_IMPORT", "CUSTOMER"]);
  assert.equal(manual.isActive, true);
  assert.equal(manual.unsubscribeTokenHash, null);
  assert.equal(cust.userId, "u1");
});

test("the unsubscribe token hash is unique, and only the hash is ever stored", async () => {
  const t = generateUnsubscribeToken();
  const c = await contact("a@example.com", { unsubscribeTokenHash: t.hash });
  assert.ok(!JSON.stringify(db.rows("emailContact")).includes(t.token), "the plaintext token is nowhere in the stored rows");
  await assert.rejects(contact("b@example.com", { unsubscribeTokenHash: t.hash }), p2002);
  const rotated = generateUnsubscribeToken();
  await db.emailContact.update({ where: { id: c.id }, data: { unsubscribeTokenHash: rotated.hash } });
  await contact("b@example.com", { unsubscribeTokenHash: t.hash }); // the old hash is free again after rotation
});

// --------------------------------------------------------------------------------------------------------------------------------- consent

test("consent keeps history: unsubscribing stamps the row, re-opting in adds a new one, and only one consent is ever open", async () => {
  const c = await contact("a@example.com");
  const first = await grant(c.id);
  await assert.rejects(grant(c.id, { source: "SIGNUP_FORM" }), p2002, "a second OPEN consent for the same contact is refused");

  await db.marketingConsent.update({ where: { id: first.id }, data: { unsubscribedAt: new Date(T0.getTime() + 86_400_000), unsubscribeSource: "LINK" } });
  const second = await grant(c.id, { source: "CUSTOMER_ACCOUNT", grantedAt: new Date(T0.getTime() + 2 * 86_400_000) });

  const history = db.rows("marketingConsent").filter((r) => r.contactId === c.id);
  assert.equal(history.length, 2, "both periods are kept");
  assert.equal(history.filter((r) => r.unsubscribedAt == null).length, 1);
  assert.equal(history.find((r) => r.id === first.id)!.unsubscribeSource, "LINK");
  assert.equal(history.find((r) => r.id === second.id)!.source, "CUSTOMER_ACCOUNT");
});

test("two different contacts can each hold an open consent", async () => {
  const a = await contact("a@example.com");
  const b = await contact("b@example.com");
  await grant(a.id);
  await grant(b.id);
  assert.equal(db.rows("marketingConsent").length, 2);
});

// ------------------------------------------------------------------------------------------------------------------------------ suppression

test("an address can be suppressed once; lifting keeps the row, and a second suppression of the same address is refused", async () => {
  const c = await contact("a@example.com");
  const s = await db.emailSuppression.create({ data: { email: "a@example.com", reason: "UNSUBSCRIBED", contactId: c.id } });
  await assert.rejects(db.emailSuppression.create({ data: { email: "a@example.com", reason: "BOUNCED" } }), p2002);
  await db.emailSuppression.create({ data: { email: "b@example.com", reason: "COMPLAINED" } }); // no contact needed: keyed by address
  await db.emailSuppression.update({ where: { id: s.id }, data: { liftedAt: T0 } });
  assert.equal(db.rows("emailSuppression").length, 2, "history kept");
});

// ------------------------------------------------------------------------------------------------------------------------------ eligibility

test("eligibility: no contact, no consent, active suppression, inactive contact, then eligible", async () => {
  assert.deepEqual(await getMarketingEligibility("nobody@example.com", { db: nowDb() }), { eligible: false, reason: "no_contact" });
  assert.deepEqual(await getMarketingEligibility("not an address", { db: nowDb() }), { eligible: false, reason: "invalid_email" });

  const c = await contact("a@example.com");
  assert.deepEqual(await getMarketingEligibility("a@example.com", { db: nowDb() }), { eligible: false, reason: "no_consent" });

  const consent = await grant(c.id);
  assert.deepEqual(await getMarketingEligibility("A@Example.com", { db: nowDb() }), { eligible: true, consentId: consent.id }, "case-insensitive lookup");

  const sup = await db.emailSuppression.create({ data: { email: "a@example.com", reason: "ADMIN" } });
  assert.deepEqual(await getMarketingEligibility("a@example.com", { db: nowDb() }), { eligible: false, reason: "suppressed" }, "a suppression beats a valid consent");

  await db.emailSuppression.update({ where: { id: sup.id }, data: { liftedAt: T0 } });
  assert.equal((await getMarketingEligibility("a@example.com", { db: nowDb() })).eligible, true, "a lifted suppression no longer blocks");

  await db.emailContact.update({ where: { id: c.id }, data: { isActive: false } });
  assert.deepEqual(await getMarketingEligibility("a@example.com", { db: nowDb() }), { eligible: false, reason: "inactive" });
});

test("unsubscribing ends eligibility; checkout progress-saving consent never makes anyone eligible", async () => {
  const c = await contact("a@example.com");
  const consent = await grant(c.id);
  assert.equal((await getMarketingEligibility("a@example.com", { db: nowDb() })).eligible, true);
  await db.marketingConsent.update({ where: { id: consent.id }, data: { unsubscribedAt: new Date(T0.getTime() + 1000), unsubscribeSource: "LINK" } });
  assert.deepEqual(await getMarketingEligibility("a@example.com", { db: nowDb() }), { eligible: false, reason: "no_consent" });

  // someone who only agreed to "save my checkout progress" has an IncompleteCheckout.consentAt but no marketing consent
  await db.incompleteCheckout.create({ data: { ownerKey: "g:abc", status: "ACTIVE", email: "saver@example.com", items: [], itemCount: 0, subtotal: 0, estimatedTotal: 0, consentAt: T0, lastActivityAt: T0 } });
  await contact("saver@example.com");
  assert.deepEqual(await getMarketingEligibility("saver@example.com", { db: nowDb() }), { eligible: false, reason: "no_consent" });
});

test("the eligibility check only reads: it creates and changes nothing", async () => {
  const c = await contact("a@example.com");
  await grant(c.id);
  const before = JSON.stringify({ c: db.rows("emailContact"), m: db.rows("marketingConsent"), s: db.rows("emailSuppression"), j: db.rows("emailJob") });
  await getMarketingEligibility("a@example.com", { db: nowDb() });
  await getMarketingEligibility("zzz@example.com", { db: nowDb() });
  assert.equal(JSON.stringify({ c: db.rows("emailContact"), m: db.rows("marketingConsent"), s: db.rows("emailSuppression"), j: db.rows("emailJob") }), before);
});

// ----------------------------------------------------------------------------------------------------------------------- campaign recipients

const campaign = (over: Record<string, unknown> = {}) => db.emailCampaign.create({ data: { name: "Eid offer", subject: "Hello", textBody: "Body", ...over } });

test("a contact is a recipient of a campaign at most once, but can receive other campaigns", async () => {
  const c = await contact("a@example.com");
  const d = await contact("b@example.com");
  const one = await campaign();
  const two = await campaign({ name: "Winter" });
  await db.emailCampaignRecipient.create({ data: { campaignId: one.id, contactId: c.id } });
  await assert.rejects(db.emailCampaignRecipient.create({ data: { campaignId: one.id, contactId: c.id } }), p2002);
  await db.emailCampaignRecipient.create({ data: { campaignId: one.id, contactId: d.id } });
  await db.emailCampaignRecipient.create({ data: { campaignId: two.id, contactId: c.id } });
  assert.equal(db.rows("emailCampaignRecipient").length, 3);
});

test("a new campaign starts as a DRAFT with zero counts and no schedule", async () => {
  const k = await campaign();
  assert.equal(k.status, "DRAFT");
  assert.deepEqual([k.recipientCount, k.sentCount, k.failedCount, k.skippedCount], [0, 0, 0, 0]);
  assert.equal(k.scheduledAt, null);
  assert.equal(k.templateId, null);
});

// ------------------------------------------------------------------------------------------------------------------------ EmailJob relation

const SMTP = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "shop@gmail.com", SMTP_PASS: "abcdefghijklmnop" };
const factory = (): any => ({ verify: async () => true, sendMail: async (m: any) => ({ messageId: "<id@x>", accepted: [m.to], rejected: [] }), close: () => {} });
const queueOpts = () => ({ db: db as never, env: SMTP, factory, now: T0, kick: false });

test("a campaign recipient links to the EmailJob the queue created, one job per recipient, and the queue still sends it", async () => {
  const c = await contact("a@example.com");
  const k = await campaign();
  // Prompt 10: the queue re-checks a campaign recipient's e-mail before sending, so this fixture is a genuinely sendable one:
  // the campaign is SENDING and the contact has a valid marketing consent.
  await db.emailCampaign.update({ where: { id: k.id }, data: { status: "SENDING", startedAt: T0 } });
  await db.marketingConsent.create({ data: { contactId: c.id, source: "ADMIN_RECORDED", grantedAt: new Date(T0.getTime() - 86_400_000) } });
  // Prompt 11: a campaign e-mail is only sent when its body carries the recipient's unsubscribe link, so the fixture's body does.
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-only-unsubscribe-secret-Zq8Lm3Vx7Rb2Nc5Kd9Wp4Ty6";
  process.env.NEXT_PUBLIC_APP_URL = "https://shop.example.com";
  const link = await getContactUnsubscribeLink(c.id, { db: db as never });
  assert.ok(link.ok);
  const job = await enqueueEmail({ kind: "campaign", dedupeParts: [k.id, "a@example.com"], to: "a@example.com", subject: "Hello", text: `Body ${link.url}` }, { ...queueOpts(), priority: "bulk" });
  assert.ok(job.ok && job.created);
  const r = await db.emailCampaignRecipient.create({ data: { campaignId: k.id, contactId: c.id, status: "QUEUED", emailJobId: job.jobId, queuedAt: T0 } });
  assert.equal(r.emailJobId, job.jobId);

  const other = await contact("b@example.com");
  await assert.rejects(db.emailCampaignRecipient.create({ data: { campaignId: k.id, contactId: other.id, emailJobId: job.jobId } }), p2002, "one job cannot serve two recipients");

  const run = await processEmailQueue({ db: db as never, env: SMTP, factory, now: T0 });
  assert.equal(run.sent, 1);
  assert.equal(db.rows("emailJob")[0].status, "SENT");
  assert.equal(db.rows("emailCampaignRecipient")[0].emailJobId, job.jobId, "the recipient row still points at the (sent) job");
  assert.equal(db.rows("emailCampaignRecipient")[0].status, "SENT", "Prompt 10: the worker settles the recipient once the job is SENT");
});

test("the link is optional: a recipient can exist without a job (not queued yet) and several can be unlinked", async () => {
  const k = await campaign();
  for (const e of ["a", "b", "c"]) {
    const c = await contact(`${e}@example.com`);
    await db.emailCampaignRecipient.create({ data: { campaignId: k.id, contactId: c.id } });
  }
  assert.equal(db.rows("emailCampaignRecipient").filter((r) => r.emailJobId === null).length, 3, "NULL job links never collide");
});

// ------------------------------------------------------------------------------------------------------------------------- recovery e-mails

test("a recovery reminder for the same event and step is recorded once, however many times it is attempted", async () => {
  const c = await contact("a@example.com");
  const key = incompleteCheckoutEventKey("ic_1")!;
  await db.recoveryEmail.create({ data: { kind: "INCOMPLETE_CHECKOUT", eventKey: key, step: 1, contactId: c.id, incompleteCheckoutId: "ic_1" } });
  await assert.rejects(db.recoveryEmail.create({ data: { kind: "INCOMPLETE_CHECKOUT", eventKey: key, step: 1, contactId: c.id, incompleteCheckoutId: "ic_1" } }), p2002);
  // a race between two workers: both try, exactly one wins
  const results = await Promise.allSettled([1, 2, 3].map(() => db.recoveryEmail.create({ data: { kind: "INCOMPLETE_CHECKOUT", eventKey: key, step: 2, contactId: c.id } })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(db.rows("recoveryEmail").length, 2, "step 1 and step 2");
});

test("abandoned-cart and incomplete-checkout reminders are distinct, and a re-abandoned cart is a new event", async () => {
  const c = await contact("a@example.com");
  const t1 = new Date("2026-11-20T10:00:00.000Z");
  const t2 = new Date("2026-11-23T10:00:00.000Z");
  const ac1 = abandonedCartEventKey("same_id", t1)!;
  const ac2 = abandonedCartEventKey("same_id", t2)!;
  const ic = incompleteCheckoutEventKey("same_id")!;
  await db.recoveryEmail.create({ data: { kind: "ABANDONED_CART", eventKey: ac1, contactId: c.id, cartId: "same_id" } });
  await assert.rejects(db.recoveryEmail.create({ data: { kind: "ABANDONED_CART", eventKey: ac1, contactId: c.id, cartId: "same_id" } }), p2002);
  await db.recoveryEmail.create({ data: { kind: "ABANDONED_CART", eventKey: ac2, contactId: c.id, cartId: "same_id" } });
  await db.recoveryEmail.create({ data: { kind: "INCOMPLETE_CHECKOUT", eventKey: ic, contactId: c.id } });
  const rows = db.rows("recoveryEmail");
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.kind === "ABANDONED_CART").length, 2);
  assert.equal(rows.filter((r) => r.kind === "INCOMPLETE_CHECKOUT").length, 1);
});

test("a recovery e-mail links to its EmailJob (one job per reminder) and defaults to PENDING at step 1", async () => {
  const c = await contact("a@example.com");
  const job = await enqueueEmail({ kind: "recovery", dedupeParts: ["ic_9", "1"], to: "a@example.com", subject: "You left something", text: "Come back" }, queueOpts());
  assert.ok(job.ok);
  const r = await db.recoveryEmail.create({ data: { kind: "INCOMPLETE_CHECKOUT", eventKey: incompleteCheckoutEventKey("ic_9")!, contactId: c.id, emailJobId: job.jobId } });
  assert.equal(r.step, 1);
  assert.equal(r.status, "PENDING");
  await assert.rejects(db.recoveryEmail.create({ data: { kind: "INCOMPLETE_CHECKOUT", eventKey: incompleteCheckoutEventKey("ic_10")!, contactId: c.id, emailJobId: job.jobId } }), p2002);
});

// ---------------------------------------------------------------------------------------------------------------- existing EmailJob behaviour

test("existing EmailJob behaviour is unchanged: transactional e-mail needs no marketing record and leaves every marketing table empty", async () => {
  const q = await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["GP-1001"], to: "buyer@example.com", subject: "Your order", text: "Thanks" }, queueOpts());
  assert.ok(q.ok && q.created);
  const again = await enqueueEmail({ kind: "order-confirmation", dedupeParts: ["GP-1001"], to: "BUYER@example.com", subject: "Your order", text: "Thanks" }, queueOpts());
  assert.ok(again.ok && !again.created && again.jobId === q.jobId, "deduplication still works");
  const run = await processEmailQueue({ db: db as never, env: SMTP, factory, now: T0 });
  assert.equal(run.sent, 1);
  const job = db.rows("emailJob")[0];
  assert.equal(job.status, "SENT");
  assert.equal(job.text, "", "body removal on SENT still happens");
  assert.deepEqual(Object.keys(job).filter((k) => /campaign|recovery|contact|consent/i.test(k)), [], "EmailJob has no marketing columns");
  for (const t of ["emailContact", "marketingConsent", "emailSuppression", "emailTemplate", "emailCampaign", "emailCampaignRecipient", "recoveryEmail"]) assert.equal(db.rows(t).length, 0, t);
});

test("the queue's housekeeping never touches recipient rows (the real ON DELETE SET NULL on purge is covered by the Postgres test)", async () => {
  const c = await contact("a@example.com");
  const k = await campaign();
  const job = await enqueueEmail({ kind: "campaign", dedupeParts: [k.id, "a@example.com"], to: "a@example.com", subject: "Hello", text: "Body" }, { ...queueOpts(), priority: "bulk" });
  assert.ok(job.ok);
  await db.emailCampaignRecipient.create({ data: { campaignId: k.id, contactId: c.id, status: "SENT", emailJobId: job.jobId, sentAt: T0 } });
  // the queue's housekeeping deletes finished jobs after the retention window; the recipient row is a different table and is not touched by it
  await processEmailQueue({ db: db as never, env: SMTP, factory, now: new Date(T0.getTime() + 40 * 86_400_000) });
  assert.equal(db.rows("emailCampaignRecipient").length, 1);
  assert.equal(db.rows("emailCampaignRecipient")[0].status, "SENT");
});
