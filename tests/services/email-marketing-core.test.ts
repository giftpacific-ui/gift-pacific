/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prompt 08: the core e-mail marketing services (contact, consent, suppression, unsubscribe, eligibility) on the in-memory database.
 * Nothing here sends mail or enqueues a job; several tests assert that EmailJob stays empty.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discardAfter, freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { findEmailContactByEmail, setEmailContactActive, upsertEmailContact } from "@/server/services/email-contact.service";
import { recordMarketingConsent, withdrawMarketingConsent } from "@/server/services/marketing-consent.service";
import { checkEmailSuppression, suppressEmail } from "@/server/services/email-suppression.service";
import { rotateUnsubscribeToken, unsubscribeByToken, unsubscribeEmail } from "@/server/services/email-unsubscribe.service";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { generateUnsubscribeToken } from "@/lib/email/marketing";

let db: FakeDb;
const realLog = { warn: console.warn, info: console.info, error: console.error };
beforeEach(() => { db = freshDb(); discardAfter(); console.warn = console.info = console.error = () => {}; });
afterEach(() => { Object.assign(console, realLog); });

const T0 = new Date("2026-11-24T08:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const NOW = at(600);
const d = () => db as never;
const elig = (email: string, now = NOW) => getMarketingEligibility(email, { db: d(), now });
const addContact = async (email: string, over: Record<string, unknown> = {}) => {
  const r = await upsertEmailContact({ email, source: "MANUAL", ...over }, { db: d() });
  assert.ok(r.ok);
  return r.contact;
};
const consent = async (contactId: string, source = "SIGNUP_FORM", now = at(1), extra: Record<string, unknown> = {}) =>
  recordMarketingConsent(contactId, { source, ...extra }, { db: d(), now });
const consentRows = (contactId: string) => db.rows("marketingConsent").filter((r) => r.contactId === contactId);

// ------------------------------------------------------------------------------------------------------------------------------- contacts

test("contacts are created normalised with their source, and the same address in any form is the same contact", async () => {
  const first = await upsertEmailContact({ email: "  Jane@Example.COM ", source: "CSV_IMPORT", name: "  Jane   Doe ", createdById: "admin1" }, { db: d() });
  assert.ok(first.ok && first.created);
  assert.equal(first.contact.email, "jane@example.com");
  assert.equal(first.contact.name, "Jane Doe");
  assert.equal(first.contact.source, "CSV_IMPORT");
  assert.equal(first.contact.isActive, true);
  assert.equal(db.rows("emailContact")[0].createdById, "admin1");

  const again = await upsertEmailContact({ email: "JANE@example.com", source: "MANUAL" }, { db: d() });
  assert.ok(again.ok && !again.created);
  assert.equal(again.contact.id, first.contact.id);
  assert.equal(db.rows("emailContact").length, 1, "no duplicate");
  assert.equal(again.contact.source, "CSV_IMPORT", "the original source is kept");
  assert.equal(again.contact.name, "Jane Doe", "no name given: stored name untouched");

  const found = await findEmailContactByEmail("jane@EXAMPLE.com", { db: d() });
  assert.equal(found?.id, first.contact.id);
  assert.equal(await findEmailContactByEmail("nobody@example.com", { db: d() }), null);
  assert.equal(await findEmailContactByEmail("not an address", { db: d() }), null);
  assert.equal(db.rows("emailContact").length, 1);
});

test("a +tag address is a different contact, and unusable input is refused without writing anything", async () => {
  await addContact("jane@example.com");
  await addContact("jane+shop@example.com");
  assert.equal(db.rows("emailContact").length, 2);

  const before = db.rows("emailContact").length;
  assert.deepEqual(await upsertEmailContact({ email: "nope", source: "MANUAL" }, { db: d() }), { ok: false, reason: "invalid_email" });
  assert.deepEqual(await upsertEmailContact({ email: "a@example.com, b@example.com", source: "MANUAL" }, { db: d() }), { ok: false, reason: "invalid_email" });
  assert.deepEqual(await upsertEmailContact({ email: null, source: "MANUAL" }, { db: d() }), { ok: false, reason: "invalid_email" });
  assert.deepEqual(await upsertEmailContact({ email: "x@example.com", source: "IMPORT" }, { db: d() }), { ok: false, reason: "invalid_source" });
  assert.deepEqual(await upsertEmailContact({ email: "x@example.com", source: undefined }, { db: d() }), { ok: false, reason: "invalid_source" });
  assert.deepEqual(await upsertEmailContact({ email: "x@example.com", source: "MANUAL", name: "n".repeat(201) }, { db: d() }), { ok: false, reason: "invalid_name" });
  assert.deepEqual(await upsertEmailContact({ email: "x@example.com", source: "MANUAL", name: 42 }, { db: d() }), { ok: false, reason: "invalid_name" });
  assert.equal(db.rows("emailContact").length, before);
});

test("updating an existing contact sets a given name, but never changes its status, consent or suppression", async () => {
  const c = await addContact("a@example.com", { name: "Old" });
  const renamed = await upsertEmailContact({ email: "a@example.com", source: "MANUAL", name: "New" }, { db: d() });
  assert.ok(renamed.ok && renamed.contact.name === "New");
  const blank = await upsertEmailContact({ email: "a@example.com", source: "MANUAL", name: "   " }, { db: d() });
  assert.ok(blank.ok && blank.contact.name === "New", "a blank name does not erase the stored one");

  await consent(c.id);
  await setEmailContactActive(c.id, false, { db: d() });
  await upsertEmailContact({ email: "A@example.com", source: "CSV_IMPORT" }, { db: d() });
  assert.equal(db.rows("emailContact")[0].isActive, false, "re-adding an address does not reactivate it");
  assert.equal(consentRows(c.id).length, 1);
  assert.equal(consentRows(c.id)[0].unsubscribedAt, null, "and does not touch its consent");
});

test("two simultaneous upserts of one address end with exactly one contact", async () => {
  const [a, b] = await Promise.all([
    upsertEmailContact({ email: "race@example.com", source: "MANUAL", name: "A" }, { db: d() }),
    upsertEmailContact({ email: "RACE@example.com", source: "CSV_IMPORT", name: "B" }, { db: d() }),
  ]);
  assert.ok(a.ok && b.ok);
  assert.equal(db.rows("emailContact").length, 1);
  assert.equal(a.contact.id, b.contact.id);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
});

test("contact status can be switched, and an unknown contact is reported", async () => {
  const c = await addContact("a@example.com");
  assert.deepEqual(await setEmailContactActive(c.id, false, { db: d() }), { ok: true });
  assert.equal(db.rows("emailContact")[0].isActive, false);
  assert.deepEqual(await setEmailContactActive(c.id, true, { db: d() }), { ok: true });
  assert.equal(db.rows("emailContact")[0].isActive, true);
  assert.deepEqual(await setEmailContactActive("missing", true, { db: d() }), { ok: false, reason: "no_contact" });
});

test("a contact links to the user who owns the address, never overwrites a valid link, and replaces a stale one", async () => {
  const jane = await db.user.create({ data: { name: "Jane", email: "Jane@Example.com" } });
  const other = await db.user.create({ data: { name: "Other", email: "other@example.com" } });
  const off = await db.user.create({ data: { name: "Off", email: "off@example.com", isActive: false } });

  const created = await upsertEmailContact({ email: "jane@example.com", source: "CUSTOMER", userId: jane.id }, { db: d() });
  assert.ok(created.ok && created.userLink === "linked" && created.contact.userId === jane.id);

  const different = await upsertEmailContact({ email: "jane@example.com", source: "CUSTOMER", userId: other.id }, { db: d() });
  assert.ok(different.ok && different.userLink === "kept_existing" && different.contact.userId === jane.id, "a valid relationship is not overwritten");
  const same = await upsertEmailContact({ email: "jane@example.com", source: "MANUAL", userId: jane.id }, { db: d() });
  assert.ok(same.ok && same.userLink === "kept_existing" && same.contact.userId === jane.id);

  // an unlinked contact: only the matching, active, existing user may be linked
  await addContact("free@example.com");
  for (const userId of [other.id, off.id, "no-such-user"]) {
    const r = await upsertEmailContact({ email: "free@example.com", source: "MANUAL", userId }, { db: d() });
    assert.ok(r.ok && r.userLink === "not_linked" && r.contact.userId === null, userId);
  }
  const noUser = await upsertEmailContact({ email: "free@example.com", source: "MANUAL" }, { db: d() });
  assert.ok(noUser.ok && noUser.userLink === "none");
  const freeUser = await db.user.create({ data: { name: "Free", email: "FREE@example.com" } });
  const linked = await upsertEmailContact({ email: "free@example.com", source: "MANUAL", userId: freeUser.id }, { db: d() });
  assert.ok(linked.ok && linked.userLink === "linked" && linked.contact.userId === freeUser.id);
  assert.equal(linked.contact.source, "MANUAL", "linking a user does not rewrite the source");

  // a recorded user that no longer exists is not a valid relationship
  await db.user.delete({ where: { id: jane.id } });
  const janeAgain = await db.user.create({ data: { name: "Jane 2", email: "jane@example.com" } });
  const relinked = await upsertEmailContact({ email: "jane@example.com", source: "CUSTOMER", userId: janeAgain.id }, { db: d() });
  assert.ok(relinked.ok && relinked.userLink === "linked" && relinked.contact.userId === janeAgain.id);
});

test("a CUSTOMER contact needs a user it can link to", async () => {
  assert.deepEqual(await upsertEmailContact({ email: "c@example.com", source: "CUSTOMER" }, { db: d() }), { ok: false, reason: "user_required" });
  const u = await db.user.create({ data: { name: "Mismatch", email: "mismatch@example.com" } });
  assert.deepEqual(await upsertEmailContact({ email: "c@example.com", source: "CUSTOMER", userId: u.id }, { db: d() }), { ok: false, reason: "user_required" });
  assert.equal(db.rows("emailContact").length, 0);
});

// --------------------------------------------------------------------------------------------------------------------------------- consent

test("consent records source, timestamp and evidence, and only then is the contact eligible", async () => {
  const c = await addContact("a@example.com");
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "no_consent" });

  const r = await consent(c.id, "CHECKOUT_MARKETING", at(5), { evidence: "  ticked 'send me offers'  ", recordedById: "admin1" });
  assert.ok(r.ok && r.created && r.suppression === "none");
  const row = consentRows(c.id)[0];
  assert.equal(row.source, "CHECKOUT_MARKETING");
  assert.equal(row.grantedAt.getTime(), at(5).getTime());
  assert.equal(row.evidence, "ticked 'send me offers'");
  assert.equal(row.recordedById, "admin1");
  assert.equal(row.unsubscribedAt, null);
  assert.deepEqual(await elig("a@example.com"), { eligible: true, consentId: row.id });
});

test("recording consent again while one is open changes nothing (no duplicate, no overwrite)", async () => {
  const c = await addContact("a@example.com");
  const first = await consent(c.id, "SIGNUP_FORM", at(1), { evidence: "form v1" });
  const second = await consent(c.id, "CUSTOMER_ACCOUNT", at(2), { evidence: "form v2" });
  assert.ok(first.ok && second.ok);
  assert.equal(second.created, false);
  assert.equal(second.consentId, first.consentId);
  assert.equal(consentRows(c.id).length, 1);
  assert.equal(consentRows(c.id)[0].source, "SIGNUP_FORM");
  assert.equal(consentRows(c.id)[0].evidence, "form v1");
  assert.equal(consentRows(c.id)[0].grantedAt.getTime(), at(1).getTime());
});

test("two simultaneous opt-ins leave exactly one open consent", async () => {
  const c = await addContact("a@example.com");
  const [a, b] = await Promise.all([consent(c.id, "SIGNUP_FORM", at(1)), consent(c.id, "CUSTOMER_ACCOUNT", at(1))]);
  assert.ok(a.ok && b.ok);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  assert.equal(consentRows(c.id).filter((r) => r.unsubscribedAt == null).length, 1);
});

test("only explicit marketing sources are accepted: checkout progress-saving consent is never marketing consent", async () => {
  const c = await addContact("saver@example.com");
  await db.incompleteCheckout.create({ data: { ownerKey: "g:abc", status: "ACTIVE", email: "saver@example.com", items: [], itemCount: 0, subtotal: 0, estimatedTotal: 0, consentAt: T0, lastActivityAt: T0 } });
  for (const source of ["CHECKOUT_PROGRESS", "INCOMPLETE_CHECKOUT", "PROGRESS_SAVING", "", undefined, null, 7]) {
    assert.deepEqual(await recordMarketingConsent(c.id, { source }, { db: d(), now: at(1) }), { ok: false, reason: "invalid_source" }, String(source));
  }
  assert.equal(consentRows(c.id).length, 0);
  assert.deepEqual(await elig("saver@example.com"), { eligible: false, reason: "no_consent" }, "having agreed to save checkout progress does not make anyone eligible");
});

test("consent input is validated: evidence too long, unknown contact, inactive contact", async () => {
  const c = await addContact("a@example.com");
  assert.deepEqual(await consent(c.id, "SIGNUP_FORM", at(1), { evidence: "e".repeat(501) }), { ok: false, reason: "invalid_evidence" });
  assert.deepEqual(await consent(c.id, "SIGNUP_FORM", at(1), { evidence: 5 }), { ok: false, reason: "invalid_evidence" });
  assert.deepEqual(await consent("missing"), { ok: false, reason: "no_contact" });
  await setEmailContactActive(c.id, false, { db: d() });
  assert.deepEqual(await consent(c.id), { ok: false, reason: "inactive" });
  assert.equal(db.rows("marketingConsent").length, 0);
});

test("withdrawal closes the consent with its source, keeps the row, ends eligibility, and is idempotent", async () => {
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(1));
  assert.equal((await elig("a@example.com")).eligible, true);

  const w = await withdrawMarketingConsent(c.id, "CUSTOMER_ACCOUNT", { db: d(), now: at(30) });
  assert.ok(w.ok && w.withdrawn);
  const row = consentRows(c.id)[0];
  assert.equal(row.unsubscribedAt.getTime(), at(30).getTime());
  assert.equal(row.unsubscribeSource, "CUSTOMER_ACCOUNT");
  assert.equal(row.source, "SIGNUP_FORM", "the original grant is untouched");
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "no_consent" });
  assert.equal(db.rows("emailSuppression").length, 0, "withdrawal alone does not suppress the address");

  const again = await withdrawMarketingConsent(c.id, "ADMIN", { db: d(), now: at(40) });
  assert.deepEqual(again, { ok: true, withdrawn: false });
  assert.equal(consentRows(c.id)[0].unsubscribeSource, "CUSTOMER_ACCOUNT", "an already-closed consent is not rewritten");
  assert.deepEqual(await withdrawMarketingConsent(c.id, "NOPE", { db: d() }), { ok: false, reason: "invalid_source" });
  assert.deepEqual(await withdrawMarketingConsent("missing", "LINK", { db: d() }), { ok: true, withdrawn: false });
});

test("withdrawal never stamps a time before the grant (clock skew)", async () => {
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(60));
  await withdrawMarketingConsent(c.id, "LINK", { db: d(), now: at(10) });
  assert.equal(consentRows(c.id)[0].unsubscribedAt.getTime(), at(60).getTime());
});

test("opting in again after a withdrawal adds a new row; the old period stays as history", async () => {
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(1));
  await withdrawMarketingConsent(c.id, "LINK", { db: d(), now: at(10) });
  const second = await consent(c.id, "CUSTOMER_ACCOUNT", at(20));
  assert.ok(second.ok && second.created);
  const rows = consentRows(c.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.source, r.unsubscribeSource]).sort(), [["CUSTOMER_ACCOUNT", null], ["SIGNUP_FORM", "LINK"]]);
  assert.equal((await elig("a@example.com")).eligible, true);
});

// ----------------------------------------------------------------------------------------------------------- unsubscribe and suppression

test("unsubscribe records the source on the consent, suppresses the address, and ends eligibility", async () => {
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(1));
  const r = await unsubscribeEmail("A@Example.com", "LINK", { db: d(), now: at(30) });
  assert.deepEqual(r, { ok: true, action: "created", consentClosed: true });
  assert.equal(consentRows(c.id)[0].unsubscribeSource, "LINK");
  assert.equal(consentRows(c.id)[0].unsubscribedAt.getTime(), at(30).getTime());
  const sup = db.rows("emailSuppression")[0];
  assert.equal(sup.email, "a@example.com");
  assert.equal(sup.reason, "UNSUBSCRIBED");
  assert.equal(sup.contactId, c.id);
  assert.equal(sup.note, "unsubscribed via LINK");
  assert.equal(sup.liftedAt, null);
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "suppressed" });
  assert.deepEqual(await checkEmailSuppression("a@example.com", { db: d() }), { suppressed: true, reason: "UNSUBSCRIBED" });

  const repeat = await unsubscribeEmail("a@example.com", "CUSTOMER_ACCOUNT", { db: d(), now: at(40) });
  assert.deepEqual(repeat, { ok: true, action: "unchanged", consentClosed: false });
  assert.equal(db.rows("emailSuppression").length, 1);
  assert.equal(consentRows(c.id)[0].unsubscribeSource, "LINK", "idempotent: the first unsubscribe event is kept");
});

test("unsubscribe input is validated: only LINK, ADMIN and CUSTOMER_ACCOUNT, and a usable address", async () => {
  for (const source of ["BOUNCE", "COMPLAINT", "EMAIL", undefined, null]) {
    assert.deepEqual(await unsubscribeEmail("a@example.com", source, { db: d() }), { ok: false, reason: "invalid_source" }, String(source));
  }
  assert.deepEqual(await unsubscribeEmail("nope", "LINK", { db: d() }), { ok: false, reason: "invalid_email" });
  assert.deepEqual(await unsubscribeEmail(undefined, "LINK", { db: d() }), { ok: false, reason: "invalid_email" });
  assert.equal(db.rows("emailSuppression").length, 0);
});

test("an address with no contact can still be unsubscribed, and the suppression is there when a contact appears later", async () => {
  assert.deepEqual(await unsubscribeEmail("ghost@example.com", "LINK", { db: d(), now: at(1) }), { ok: true, action: "created", consentClosed: false });
  assert.equal(db.rows("emailSuppression")[0].contactId, null);
  const c = await addContact("ghost@example.com");
  assert.deepEqual(await elig("ghost@example.com"), { eligible: false, reason: "suppressed" });
  assert.deepEqual(await consent(c.id, "CSV_IMPORT"), { ok: false, reason: "suppressed" }, "a bulk import cannot resubscribe an opted-out address");
  assert.equal(db.rows("marketingConsent").length, 0);
});

test("resubscribing cannot silently bypass an unsubscribe: only a new explicit consent restores eligibility", async () => {
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(1));
  await unsubscribeEmail("a@example.com", "LINK", { db: d(), now: at(10) });

  // re-adding the contact, an import and a reactivation do nothing to the suppression
  await upsertEmailContact({ email: "a@example.com", source: "CSV_IMPORT", name: "A" }, { db: d() });
  await setEmailContactActive(c.id, false, { db: d() });
  await setEmailContactActive(c.id, true, { db: d() });
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "suppressed" });

  // consents that may not lift it are refused and leave no open consent behind
  assert.deepEqual(await consent(c.id, "CSV_IMPORT", at(20), { evidence: "list.csv" }), { ok: false, reason: "suppressed" });
  assert.deepEqual(await consent(c.id, "ADMIN_RECORDED", at(21)), { ok: false, reason: "suppressed" }, "admin consent needs evidence");
  assert.equal(consentRows(c.id).length, 1);
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "suppressed" });

  // a deliberate new consent lifts it, and the history is all still there
  const back = await consent(c.id, "CUSTOMER_ACCOUNT", at(30), { recordedById: "u1" });
  assert.ok(back.ok && back.created && back.suppression === "lifted");
  assert.deepEqual(await elig("a@example.com"), { eligible: true, consentId: back.consentId });
  const sup = db.rows("emailSuppression");
  assert.equal(sup.length, 1, "the suppression row is kept");
  assert.equal(sup[0].liftedAt.getTime(), at(30).getTime());
  assert.equal(sup[0].liftedById, "u1");
  assert.equal(consentRows(c.id).length, 2);
  assert.equal(consentRows(c.id).find((r) => r.id !== back.consentId)!.unsubscribeSource, "LINK");

  // unsubscribing once more reactivates the same row and closes the new consent
  assert.deepEqual(await unsubscribeEmail("a@example.com", "ADMIN", { db: d(), now: at(40) }), { ok: true, action: "reactivated", consentClosed: true });
  assert.equal(db.rows("emailSuppression").length, 1);
  assert.equal(db.rows("emailSuppression")[0].liftedAt, null);
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "suppressed" });
});

test("an admin-recorded consent with written evidence can restore an unsubscribed address", async () => {
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(1));
  await unsubscribeEmail("a@example.com", "LINK", { db: d(), now: at(5) });
  const r = await consent(c.id, "ADMIN_RECORDED", at(10), { evidence: "asked by phone, ticket 123", recordedById: "admin1" });
  assert.ok(r.ok && r.suppression === "lifted");
  assert.equal((await elig("a@example.com")).eligible, true);
});

test("bounced, complained and manual suppressions block, close the consent with the matching source, and consent cannot lift them", async () => {
  const cases = [
    ["BOUNCED", "BOUNCE", "bounce@example.com"],
    ["COMPLAINED", "COMPLAINT", "complaint@example.com"],
    ["ADMIN", "ADMIN", "manual@example.com"],
  ] as const;
  for (const [reason, source, email] of cases) {
    const c = await addContact(email);
    await consent(c.id, "SIGNUP_FORM", at(1));
    assert.equal((await elig(email)).eligible, true, email);
    const r = await suppressEmail(email, { reason, note: "  from the provider  ", actorId: "sys" }, { db: d(), now: at(10) });
    assert.deepEqual(r, { ok: true, action: "created", effectiveReason: reason, consentClosed: true });
    assert.equal(consentRows(c.id)[0].unsubscribeSource, source);
    assert.deepEqual(await elig(email), { eligible: false, reason: "suppressed" }, reason);
    assert.deepEqual(await checkEmailSuppression(email, { db: d() }), { suppressed: true, reason });
    assert.deepEqual(await consent(c.id, "CUSTOMER_ACCOUNT", at(20)), { ok: false, reason: "suppressed" }, `${reason} is not lifted by a consent`);
    assert.equal(consentRows(c.id).length, 1);
  }
  const bounced = db.rows("emailSuppression").find((r) => r.email === "bounce@example.com");
  assert.equal(bounced!.note, "from the provider");
  assert.equal(bounced!.createdById, "sys");
});

test("a stronger suppression is never downgraded by a weaker one, and a weaker one is upgraded", async () => {
  await suppressEmail("a@example.com", { reason: "COMPLAINED" }, { db: d(), now: at(1) });
  const weaker = await suppressEmail("a@example.com", { reason: "UNSUBSCRIBED", unsubscribeSource: "LINK" }, { db: d(), now: at(2) });
  assert.deepEqual(weaker, { ok: true, action: "unchanged", effectiveReason: "COMPLAINED", consentClosed: false });
  assert.equal(db.rows("emailSuppression")[0].reason, "COMPLAINED");
  assert.deepEqual(await unsubscribeEmail("a@example.com", "LINK", { db: d(), now: at(3) }), { ok: true, action: "unchanged", consentClosed: false });
  assert.equal(db.rows("emailSuppression")[0].reason, "COMPLAINED");

  await unsubscribeEmail("b@example.com", "LINK", { db: d(), now: at(1) });
  const stronger = await suppressEmail("b@example.com", { reason: "BOUNCED" }, { db: d(), now: at(2) });
  assert.deepEqual(stronger, { ok: true, action: "upgraded", effectiveReason: "BOUNCED", consentClosed: false });
  assert.equal(db.rows("emailSuppression").length, 2, "still one row per address");
  assert.equal(db.rows("emailSuppression").find((r) => r.email === "b@example.com")!.reason, "BOUNCED");
});

test("a lifted suppression is reactivated with the new reason instead of being duplicated", async () => {
  const s = await db.emailSuppression.create({ data: { email: "a@example.com", reason: "BOUNCED", liftedAt: T0, liftedById: "admin1" } });
  const r = await suppressEmail("a@example.com", { reason: "COMPLAINED" }, { db: d(), now: at(5) });
  assert.deepEqual(r, { ok: true, action: "reactivated", effectiveReason: "COMPLAINED", consentClosed: false });
  const rows = db.rows("emailSuppression");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, s.id);
  assert.equal(rows[0].reason, "COMPLAINED");
  assert.equal(rows[0].liftedAt, null);
  assert.equal(rows[0].liftedById, null);
});

test("suppression input is validated and a refused call writes nothing", async () => {
  assert.deepEqual(await suppressEmail("nope", { reason: "ADMIN" }, { db: d() }), { ok: false, reason: "invalid_email" });
  assert.deepEqual(await suppressEmail("a@example.com", { reason: "SPAM" }, { db: d() }), { ok: false, reason: "invalid_reason" });
  assert.deepEqual(await suppressEmail("a@example.com", { reason: undefined }, { db: d() }), { ok: false, reason: "invalid_reason" });
  assert.deepEqual(await suppressEmail("a@example.com", { reason: "ADMIN", note: "n".repeat(501) }, { db: d() }), { ok: false, reason: "invalid_note" });
  assert.deepEqual(await suppressEmail("a@example.com", { reason: "UNSUBSCRIBED", unsubscribeSource: "FAX" }, { db: d() }), { ok: false, reason: "invalid_source" });
  assert.equal(db.rows("emailSuppression").length, 0);
});

test("unsubscribe by token (P08 hash lookup): unknown and malformed tokens change nothing; \"rotating\" is now stable and never kills a link already sent", async () => {
  const uenv = { EMAIL_UNSUBSCRIBE_SECRET: "test-only-unsubscribe-secret-Zq8Lm3Vx7Rb2Nc5Kd9Wp4Ty6", NEXT_PUBLIC_APP_URL: "https://shop.example.com" };
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(1));
  const issued = await rotateUnsubscribeToken(c.id, { db: d(), env: uenv });
  assert.ok(issued.ok);
  assert.ok(!JSON.stringify(db.rows("emailContact")).includes(issued.token), "the plaintext token is never stored");
  assert.deepEqual(await rotateUnsubscribeToken("missing", { db: d(), env: uenv }), { ok: false, reason: "no_contact" });
  assert.deepEqual(await rotateUnsubscribeToken(c.id, { db: d(), env: {} }), { ok: false, reason: "secret_unavailable" }, "no secret = no token, no weak fallback");

  assert.deepEqual(await unsubscribeByToken("short", { db: d() }), { ok: false, reason: "invalid_token" });
  assert.deepEqual(await unsubscribeByToken(undefined, { db: d() }), { ok: false, reason: "invalid_token" });
  assert.deepEqual(await unsubscribeByToken(generateUnsubscribeToken().token, { db: d() }), { ok: false, reason: "unknown_token" });
  assert.equal(db.rows("emailSuppression").length, 0);

  const again = await rotateUnsubscribeToken(c.id, { db: d(), env: uenv });
  assert.ok(again.ok);
  assert.equal(again.token, issued.token, "the same contact keeps the SAME token: a link that was already e-mailed still works");
  assert.deepEqual(await unsubscribeByToken(issued.token, { db: d(), now: at(30) }), { ok: true, action: "created", consentClosed: true });
  assert.equal(consentRows(c.id)[0].unsubscribeSource, "LINK");
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "suppressed" });
});

// ----------------------------------------------------------------------------------------------------------------------------- eligibility

test("eligibility needs a valid consent and no suppression: every blocking case, then the eligible one", async () => {
  assert.deepEqual(await elig("nobody@example.com"), { eligible: false, reason: "no_contact" });
  assert.deepEqual(await getMarketingEligibility("nope", { db: d(), now: NOW }), { eligible: false, reason: "invalid_email" });
  const c = await addContact("a@example.com");
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "no_consent" });
  await consent(c.id, "SIGNUP_FORM", at(1));
  assert.equal((await elig("  A@EXAMPLE.com ")).eligible, true);
  await setEmailContactActive(c.id, false, { db: d() });
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "inactive" });
  await setEmailContactActive(c.id, true, { db: d() });
  assert.equal((await elig("a@example.com")).eligible, true);
});

test("a suppression with no contact still blocks, and survives contact deactivation and reactivation", async () => {
  await suppressEmail("a@example.com", { reason: "BOUNCED" }, { db: d(), now: at(1) });
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "suppressed" });
  const c = await addContact("a@example.com");
  await setEmailContactActive(c.id, false, { db: d() });
  await setEmailContactActive(c.id, true, { db: d() });
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "suppressed" });
});

test("a consent row that is not valid does not count: future-dated, unknown source, or already closed", async () => {
  const c = await addContact("a@example.com");
  const future = await db.marketingConsent.create({ data: { contactId: c.id, source: "SIGNUP_FORM", grantedAt: new Date(NOW.getTime() + 60_000) } });
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "no_consent" });
  assert.equal((await elig("a@example.com", new Date(NOW.getTime() + 120_000))).eligible, true, "valid once its time has come");
  await db.marketingConsent.update({ where: { id: future.id }, data: { unsubscribedAt: new Date(NOW.getTime() + 61_000), unsubscribeSource: "LINK" } });
  assert.deepEqual(await elig("a@example.com", new Date(NOW.getTime() + 120_000)), { eligible: false, reason: "no_consent" });

  const c2 = await addContact("b@example.com");
  await db.marketingConsent.create({ data: { contactId: c2.id, source: "CHECKOUT_PROGRESS", grantedAt: T0 } });
  assert.deepEqual(await elig("b@example.com"), { eligible: false, reason: "no_consent" }, "a corrupt row from a non-marketing source never makes anyone eligible");
});

test("an active suppression with a reason this code does not know still blocks (unverifiable)", async () => {
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(1));
  await db.emailSuppression.create({ data: { email: "a@example.com", reason: "SOMETHING_NEW" } });
  assert.deepEqual(await elig("a@example.com"), { eligible: false, reason: "unverifiable" });
  assert.deepEqual(await checkEmailSuppression("a@example.com", { db: d() }), { suppressed: true, reason: "unverifiable" });
});

test("eligibility fails closed when any lookup fails, and the suppression check does too", async () => {
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(1));
  assert.equal((await elig("a@example.com")).eligible, true);
  const boom = () => { throw new Error("database unavailable"); };
  const broken = (table: string, method: string) => ({ ...(db as any), [table]: { ...(db as any)[table], [method]: boom } }) as never;

  for (const [table, method] of [["emailSuppression", "findFirst"], ["emailContact", "findUnique"], ["marketingConsent", "findFirst"]] as const) {
    assert.deepEqual(await getMarketingEligibility("a@example.com", { db: broken(table, method), now: NOW }), { eligible: false, reason: "unverifiable" }, `${table}.${method}`);
  }
  assert.deepEqual(await checkEmailSuppression("a@example.com", { db: broken("emailSuppression", "findFirst") }), { suppressed: true, reason: "unverifiable" });
  assert.deepEqual(await checkEmailSuppression("not an address", { db: d() }), { suppressed: true, reason: "unverifiable" });
  assert.deepEqual(await checkEmailSuppression("clean@example.com", { db: d() }), { suppressed: false });
});

test("nothing in the marketing services sends mail or enqueues a job, and eligibility only reads", async () => {
  const c = await addContact("a@example.com");
  await consent(c.id, "SIGNUP_FORM", at(1));
  await unsubscribeEmail("a@example.com", "LINK", { db: d(), now: at(5) });
  await consent(c.id, "CUSTOMER_ACCOUNT", at(10));
  await suppressEmail("z@example.com", { reason: "BOUNCED" }, { db: d(), now: at(11) });
  const tables = ["emailContact", "marketingConsent", "emailSuppression"] as const;
  const snapshot = JSON.stringify(tables.map((t) => db.rows(t)));
  await elig("a@example.com");
  await elig("z@example.com");
  await elig("nobody@example.com");
  assert.equal(JSON.stringify(tables.map((t) => db.rows(t))), snapshot, "eligibility wrote nothing");
  for (const t of ["emailJob", "emailCampaign", "emailCampaignRecipient", "recoveryEmail"]) assert.equal(db.rows(t).length, 0, t);
});
