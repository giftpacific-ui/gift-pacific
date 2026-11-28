/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * P12-UI-01: Email marketing > Contacts on the in-memory database. The REAL existing services (contact, consent, suppression, eligibility) run underneath;
 * nothing here re-implements them. Nothing in this feature sends mail, so several tests also assert that EmailJob stays empty.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discardAfter, freshDb, runAs, seedAdmins } from "../setup/helpers";
import { installDb, type FakeDb } from "../setup/fake-db";
import { upsertEmailContact, setEmailContactActive } from "@/server/services/email-contact.service";
import { recordMarketingConsent, withdrawMarketingConsent } from "@/server/services/marketing-consent.service";
import { suppressEmail } from "@/server/services/email-suppression.service";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import {
  adminCreateEmailContact, adminGetEmailContactDetail, adminGetEmailContactStats, adminImportContactCsv, adminListEmailContacts, adminPreviewContactCsv,
  adminSetEmailContactActive, adminSetEmailContactsActive,
} from "@/server/services/email-contact-admin.service";
import {
  createEmailContactAction, importEmailContactsCsvAction, previewEmailContactsCsvAction, setEmailContactActiveAction, setEmailContactsActiveAction,
} from "@/server/actions/admin-email-contact.actions";

let db: FakeDb;
const realLog = { warn: console.warn, info: console.info, error: console.error };
beforeEach(() => {
  db = freshDb();
  discardAfter();
  seedAdmins(db); // "admin-1" is the signed-in admin of the action stub
  db.insert("user", { id: "cust-9", email: "c9@x.test", name: "Customer Nine", role: "CUSTOMER", isActive: true });
  db.insert("user", { id: "adm-off", email: "off@staff.test", name: "Deactivated", role: "ADMIN", isActive: false });
  console.warn = console.info = console.error = () => {};
});
afterEach(() => { Object.assign(console, realLog); });

const A = "admin-1";
const d = () => db as never;
const T0 = new Date(Date.now() - 10 * 86_400_000); // ten days ago: every consent below is already in the past for the real clock
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const EVIDENCE = "Ticked the newsletter box on the 2026 sign-up sheet";
const contacts = () => db.rows("emailContact");
const consents = (email?: string) => db.rows("marketingConsent").filter((c) => !email || c.contactId === contacts().find((x) => x.email === email)?.id);
const suppressionOf = (email: string) => db.rows("emailSuppression").find((s) => s.email === email);
const elig = (email: string) => getMarketingEligibility(email, { db: d() });
const csvOf = (rows: string[]) => `email,name,marketing_consent,consent_evidence\n${rows.join("\n")}\n`;

type Seed = { name?: string; source?: "MANUAL" | "CSV_IMPORT" | "CUSTOMER"; consent?: boolean; inactive?: boolean; suppress?: "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED" | "ADMIN"; withdrawn?: boolean; userId?: string; minutes?: number };
async function seed(email: string, o: Seed = {}) {
  const r = await upsertEmailContact({ email, source: o.source ?? "MANUAL", name: o.name, userId: o.userId }, { db: d() });
  assert.ok(r.ok, JSON.stringify(r));
  if (o.minutes !== undefined) db.patch("emailContact", r.contact.id, { createdAt: at(o.minutes) });
  if (o.consent || o.withdrawn) assert.ok((await recordMarketingConsent(r.contact.id, { source: "SIGNUP_FORM" }, { db: d(), now: at(-60) })).ok);
  if (o.withdrawn) await withdrawMarketingConsent(r.contact.id, "LINK", { db: d(), now: at(-30) });
  if (o.suppress) await suppressEmail(email, { reason: o.suppress, actorId: A }, { db: d(), now: at(-20) });
  if (o.inactive) await setEmailContactActive(r.contact.id, false, { db: d() });
  return r.contact;
}
const snapshot = () => JSON.stringify({ c: db.rows("emailContact"), k: db.rows("marketingConsent"), s: db.rows("emailSuppression") });
const SUPPRESSIONS = ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "ADMIN"] as const;

// ------------------------------------------------------------------------------------------------------------------------ admin access

test("every admin action refuses a visitor, a customer and a signed-out request, and writes nothing", async () => {
  const before = snapshot();
  const calls: [string, () => Promise<unknown>][] = [
    ["create", () => createEmailContactAction({ email: "a@x.com" })],
    ["preview", () => previewEmailContactsCsvAction(csvOf(["a@x.com,A,,"]))],
    ["import", () => importEmailContactsCsvAction(csvOf(["a@x.com,A,,"]), false)],
    ["toggle", () => setEmailContactActiveAction("c1", false)],
    ["bulk toggle", () => setEmailContactsActiveAction(["c1"], false)],
  ];
  for (const who of [null, { sub: "cust-9" }] as const) {
    for (const [name, call] of calls) await assert.rejects(runAs(who, call), /FORBIDDEN/, `${name} as ${JSON.stringify(who)}`);
  }
  assert.equal(snapshot(), before);
});

test("the services authorise their actor themselves: no actor, an unknown id, a customer and a deactivated admin are refused before anything is read or written", async () => {
  await seed("keep@x.com");
  const before = snapshot();
  for (const actor of [undefined, null, "", "ghost", "cust-9", "adm-off", 42]) {
    const label = String(actor);
    await assert.rejects(adminListEmailContacts(actor, {}, { db: d() }), /not authorised/i, `list ${label}`);
    await assert.rejects(adminGetEmailContactStats(actor, { db: d() }), /not authorised/i, `stats ${label}`);
    await assert.rejects(adminGetEmailContactDetail(actor, contacts()[0].id, { db: d() }), /not authorised/i, `detail ${label}`);
    await assert.rejects(adminCreateEmailContact(actor, { email: "new@x.com" }, { db: d() }), /not authorised/i, `create ${label}`);
    await assert.rejects(adminPreviewContactCsv(actor, csvOf(["new@x.com,,,"]), { db: d() }), /not authorised/i, `preview ${label}`);
    await assert.rejects(adminImportContactCsv(actor, csvOf(["new@x.com,,,"]), {}, { db: d() }), /not authorised/i, `import ${label}`);
    await assert.rejects(adminSetEmailContactActive(actor, contacts()[0].id, false, { db: d() }), /not authorised/i, `toggle ${label}`);
    await assert.rejects(adminSetEmailContactsActive(actor, [contacts()[0].id], false, { db: d() }), /not authorised/i, `bulk ${label}`);
  }
  assert.equal(snapshot(), before);
});

test("an action failing on the database returns a generic message: no internal detail reaches the client", async () => {
  const broken: any = new Proxy({}, { get: () => { throw Object.assign(new Error("P1001: cannot reach postgres://app:hunter2@db.internal:5432/giftpacific"), { code: "P1001" }); } });
  installDb(broken);
  const res = await runAs("admin", () => createEmailContactAction({ email: "a@x.com" }));
  assert.equal(res.success, false);
  assert.ok(!res.success && !/P1001|hunter2|postgres|db\.internal/.test(res.message), res.success ? "" : res.message);
});

test("the pages re-check the admin themselves, the sidebar links to the page, and no source file touches the send path", () => {
  const list = readFileSync("src/app/admin/(dashboard)/email-marketing/contacts/page.tsx", "utf8");
  const detail = readFileSync("src/app/admin/(dashboard)/email-marketing/contacts/[id]/page.tsx", "utf8");
  for (const [name, text] of [["list", list], ["detail", detail]]) assert.match(text, /requireAdmin\(\)/, `${name} page must call requireAdmin()`);
  assert.match(detail, /notFound\(\)/);
  assert.match(readFileSync("src/config/admin-nav.ts", "utf8"), /href: "\/admin\/email-marketing\/contacts"/);
  for (const f of ["src/server/services/email-contact-admin.service.ts", "src/server/actions/admin-email-contact.actions.ts", "src/lib/email/contact-admin-rules.ts", "src/lib/email-contacts.ts"]) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/email-queue|email-campaign|sendSmtpMail|nodemailer|enqueue|emailJob|unsubscribeTokenHash/i.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), `${f} touches the send path or the token hash`);
  }
});

// ------------------------------------------------------------------------------------------------------------------------ manual creation

test("a contact is created normalised, as MANUAL, by the signed-in admin, with NO consent, and nothing is queued", async () => {
  const res = await runAs("admin", () => createEmailContactAction({ email: "  Jane@Example.COM ", name: "  Jane   Doe " }));
  assert.ok(res.success && res.created && res.consent === "not_requested", JSON.stringify(res));
  assert.match(res.success ? res.message : "", /No marketing consent was recorded/);
  assert.equal(contacts().length, 1);
  assert.deepEqual([contacts()[0].email, contacts()[0].name, contacts()[0].source, contacts()[0].isActive, contacts()[0].createdById], ["jane@example.com", "Jane Doe", "MANUAL", true, "admin-1"]);
  assert.equal(consents().length, 0, "creating a contact never grants consent");
  assert.deepEqual(await elig("jane@example.com"), { eligible: false, reason: "no_consent" });
  assert.equal(db.rows("emailJob").length, 0);
});

test("invalid addresses and names are refused with a field message and nothing is saved", async () => {
  for (const bad of ["", "   ", "not-an-address", "a@b", "two@x.com, three@x.com", "Jane <jane@x.com>", "a@x.com\nBcc: b@x.com", `${"a".repeat(250)}@x.com`, null, 7, {}]) {
    const res = await adminCreateEmailContact(A, { email: bad }, { db: d() });
    assert.ok(!res.ok && res.field === "email" && res.message.length > 0, `${JSON.stringify(bad)} -> ${JSON.stringify(res)}`);
  }
  const longName = await adminCreateEmailContact(A, { email: "ok@x.com", name: "n".repeat(201) }, { db: d() });
  assert.ok(!longName.ok && longName.field === "name");
  const badName = await adminCreateEmailContact(A, { email: "ok@x.com", name: { x: 1 } }, { db: d() });
  assert.ok(!badName.ok && badName.field === "name");
  assert.equal(contacts().length, 0);
});

test("re-adding an address in any form is the same contact: no duplicate, source, status and consent untouched", async () => {
  const first = await adminCreateEmailContact(A, { email: "jane@x.com", name: "Jane" }, { db: d() });
  assert.ok(first.ok && first.created);
  const again = await adminCreateEmailContact(A, { email: " JANE@x.com " }, { db: d() });
  assert.ok(again.ok && !again.created && again.contactId === first.contactId);
  assert.match(again.ok ? again.message : "", /already a contact/);
  assert.equal(contacts().length, 1);
  assert.equal(contacts()[0].name, "Jane", "no name given: stored name untouched");
  assert.equal(consents().length, 0);
});

test("explicit admin consent needs evidence: with it the consent is recorded by recordMarketingConsent (ADMIN_RECORDED) and the contact becomes eligible", async () => {
  const res = await runAs("admin", () => createEmailContactAction({ email: "opt@x.com", name: "Opt In", grantConsent: true, consentEvidence: `  ${EVIDENCE}  ` }));
  assert.ok(res.success && res.created && res.consent === "recorded", JSON.stringify(res));
  assert.equal(consents().length, 1);
  const row = consents()[0];
  assert.deepEqual([row.source, row.evidence, row.recordedById, row.unsubscribedAt ?? null], ["ADMIN_RECORDED", EVIDENCE, "admin-1", null]);
  assert.equal((await elig("opt@x.com")).eligible, true);
});

test("consent without adequate evidence is refused BEFORE anything is saved; a non-boolean consent flag is refused too", async () => {
  for (const evidence of [undefined, "", "   ", "yes", "true", "x".repeat(501), 5]) {
    const res = await adminCreateEmailContact(A, { email: "opt@x.com", grantConsent: true, consentEvidence: evidence }, { db: d() });
    assert.ok(!res.ok && res.field === "consentEvidence", `${String(evidence).slice(0, 10)} -> ${JSON.stringify(res)}`);
  }
  for (const flag of ["true", 1, "on", {}, []]) {
    const res = await adminCreateEmailContact(A, { email: "opt@x.com", grantConsent: flag, consentEvidence: EVIDENCE }, { db: d() });
    assert.ok(!res.ok && res.field === "grantConsent", String(flag));
  }
  assert.equal(contacts().length, 0, "a refused request leaves no half-created contact");
  assert.equal(consents().length, 0);
});

test("evidence typed without the consent box ticked records nothing", async () => {
  const res = await adminCreateEmailContact(A, { email: "x@x.com", grantConsent: false, consentEvidence: EVIDENCE }, { db: d() });
  assert.ok(res.ok && res.consent === "not_requested");
  assert.equal(consents().length, 0);
});

test("being a customer, having an order or saving checkout progress is never consent: creating or importing such an address records none", async () => {
  await seed("c9@x.test", { source: "CUSTOMER", userId: "cust-9" });
  db.insert("incompleteCheckout", { id: "ic1", ownerKey: "u:cust-9", email: "c9@x.test", consentAt: new Date(), status: "ACTIVE" });
  db.insert("order", { id: "o1", orderNumber: "GP-1", emailNorm: "c9@x.test" });
  const created = await adminCreateEmailContact(A, { email: "c9@x.test" }, { db: d() });
  assert.ok(created.ok && !created.created && created.consent === "not_requested");
  const imported = await adminImportContactCsv(A, csvOf(["c9@x.test,Customer Nine,,"]), {}, { db: d() });
  assert.ok(imported.ok && imported.summary.consentRecorded === 0);
  assert.equal(consents().length, 0);
  assert.deepEqual(await elig("c9@x.test"), { eligible: false, reason: "no_consent" });
});

// -------------------------------------------------------------------------------------------------------------------- suppression protection

for (const reason of SUPPRESSIONS) {
  test(`${reason}: adding the contact again, with or without consent, never lifts the suppression, restores consent or reactivates it`, async () => {
    const c = await seed("sup@x.com", { consent: true, suppress: reason });
    const before = JSON.stringify({ k: consents("sup@x.com"), s: suppressionOf("sup@x.com") });
    assert.ok(suppressionOf("sup@x.com").liftedAt == null);

    const plain = await adminCreateEmailContact(A, { email: "sup@x.com" }, { db: d() });
    assert.ok(plain.ok && !plain.created && plain.consent === "not_requested");
    const withConsent = await adminCreateEmailContact(A, { email: "SUP@x.com", grantConsent: true, consentEvidence: EVIDENCE }, { db: d() });
    assert.ok(withConsent.ok && withConsent.consent === "blocked_suppressed", JSON.stringify(withConsent));
    assert.match(withConsent.ok ? withConsent.message : "", /NOT recorded/);

    assert.equal(JSON.stringify({ k: consents("sup@x.com"), s: suppressionOf("sup@x.com") }), before, "consent history and suppression are byte-for-byte unchanged");
    assert.equal(suppressionOf("sup@x.com").liftedAt ?? null, null);
    assert.equal(consents("sup@x.com").filter((k) => k.unsubscribedAt == null).length, 0, "no open consent was created");
    assert.deepEqual(await elig("sup@x.com"), { eligible: false, reason: "suppressed" });
    assert.equal(db.get("emailContact", c.id).isActive, true);
  });

  test(`${reason}: a CSV row that says marketing_consent=true is blocked and counted; the suppression, history and status are untouched`, async () => {
    await seed("sup@x.com", { consent: true, suppress: reason, inactive: true });
    const before = JSON.stringify({ k: consents("sup@x.com"), s: suppressionOf("sup@x.com") });
    const res = await adminImportContactCsv(A, csvOf([`sup@x.com,Renamed,true,${EVIDENCE}`]), { attestConsent: true }, { db: d() });
    assert.ok(res.ok);
    assert.deepEqual([res.summary.consentRecorded, res.summary.consentBlocked, res.summary.skippedOrBlocked, res.summary.existingContacts], [0, 1, 1, 1]);
    assert.match(res.summary.issues.map((i) => i.message).join(" "), /suppressed/);
    assert.equal(JSON.stringify({ k: consents("sup@x.com"), s: suppressionOf("sup@x.com") }), before);
    assert.equal(contacts()[0].isActive, false, "an import never reactivates a contact");
    assert.equal(contacts()[0].source, "MANUAL", "the original source is kept");
    assert.equal((await elig("sup@x.com")).eligible, false);
  });
}

test("a suppression recorded for an address BEFORE it had a contact still protects it when the contact is added or imported", async () => {
  await suppressEmail("early@x.com", { reason: "UNSUBSCRIBED", unsubscribeSource: "LINK" }, { db: d() });
  assert.equal(suppressionOf("early@x.com").contactId, null);
  const res = await adminCreateEmailContact(A, { email: "early@x.com", grantConsent: true, consentEvidence: EVIDENCE }, { db: d() });
  assert.ok(res.ok && res.created && res.consent === "blocked_suppressed");
  const imp = await adminImportContactCsv(A, csvOf([`early@x.com,E,true,${EVIDENCE}`]), { attestConsent: true }, { db: d() });
  assert.ok(imp.ok && imp.summary.consentBlocked === 1);
  assert.equal(consents().length, 0);
  assert.equal(suppressionOf("early@x.com").liftedAt ?? null, null);
  const list = await adminListEmailContacts(A, { filter: "unsubscribed" }, { db: d() });
  assert.deepEqual(list.rows.map((r) => r.email), ["early@x.com"], "found by address even though the suppression row has no contact id");
});

test("an inactive contact is never reactivated by adding it or importing it; consent for it is refused", async () => {
  await seed("off@x.com", { inactive: true });
  const res = await adminCreateEmailContact(A, { email: "off@x.com", grantConsent: true, consentEvidence: EVIDENCE }, { db: d() });
  assert.ok(res.ok && res.consent === "blocked_inactive");
  const imp = await adminImportContactCsv(A, csvOf([`off@x.com,,true,${EVIDENCE}`]), { attestConsent: true }, { db: d() });
  assert.ok(imp.ok && imp.summary.consentBlocked === 1 && imp.summary.consentRecorded === 0);
  assert.equal(contacts()[0].isActive, false);
  assert.equal(consents().length, 0);
});

// ------------------------------------------------------------------------------------------------- concurrent suppression (race regression)

/**
 * A db whose consent transaction is interleaved with ANOTHER request that records a suppression for the same address:
 *  - "beforeRead":  the suppression is committed after the admin form began but before the consent transaction reads suppressions;
 *  - "afterRead":   it is committed after that transaction read "no suppression" and before it writes the consent.
 * (The in-memory db serialises transactions, so the other request's committed row is inserted directly.)
 */
function racingDb(email: string, reason: (typeof SUPPRESSIONS)[number], when: "beforeRead" | "afterRead"): FakeDb {
  let fired = false;
  const inject = () => {
    if (fired) return;
    fired = true;
    const contact = contacts().find((c) => c.email === email);
    db.insert("emailSuppression", { email, reason, contactId: contact?.id ?? null, note: "concurrent request" });
  };
  return new Proxy(db, {
    get(target, key) {
      const value = (target as any)[key];
      if (key !== "$transaction") return typeof value === "function" ? value.bind(target) : value;
      return async (fn: any) => {
        if (when === "beforeRead") inject();
        return target.$transaction(async (tx: any) => fn(when === "afterRead"
          ? new Proxy(tx, { get: (t, k) => (k === "marketingConsent" ? { ...t.marketingConsent, create: async (a: any) => { inject(); return t.marketingConsent.create(a); } } : t[k]) })
          : tx));
      };
    },
  }) as unknown as FakeDb;
}

for (const reason of SUPPRESSIONS) {
  test(`RACE ${reason} lands before the consent transaction reads: the admin form refuses, the suppression stays active and no consent is written`, async () => {
    await seed("race@x.com");
    const racing = racingDb("race@x.com", reason, "beforeRead");
    const res = await adminCreateEmailContact(A, { email: "race@x.com", grantConsent: true, consentEvidence: EVIDENCE }, { db: racing as never });
    assert.ok(res.ok && res.consent === "blocked_suppressed", JSON.stringify(res));
    const sup = suppressionOf("race@x.com");
    assert.deepEqual([sup.reason, sup.liftedAt ?? null, sup.liftedById ?? null], [reason, null, null], "the suppression was not lifted");
    assert.equal(consents("race@x.com").length, 0, "nothing was appended to the consent history");
    assert.deepEqual(await elig("race@x.com"), { eligible: false, reason: "suppressed" });
  });

  test(`RACE ${reason} lands after the suppression read, before the consent write: it stays active, is never lifted, and wins over the consent`, async () => {
    await seed("race@x.com");
    const racing = racingDb("race@x.com", reason, "afterRead");
    const res = await adminCreateEmailContact(A, { email: "race@x.com", grantConsent: true, consentEvidence: EVIDENCE }, { db: racing as never });
    assert.ok(res.ok, JSON.stringify(res));
    const sup = suppressionOf("race@x.com");
    assert.deepEqual([sup.reason, sup.liftedAt ?? null, sup.liftedById ?? null], [reason, null, null], "the suppression was not lifted");
    assert.deepEqual(await elig("race@x.com"), { eligible: false, reason: "suppressed" }, "suppression takes precedence over the consent");
  });
}

test("the same interleaving WITHOUT the new option is the hazard being fixed: P08's default lets admin-recorded consent with evidence end an UNSUBSCRIBED suppression (unchanged P08 precedence)", async () => {
  const c = await seed("p08@x.com");
  const racing = racingDb("p08@x.com", "UNSUBSCRIBED", "beforeRead");
  const res = await recordMarketingConsent(c.id, { source: "ADMIN_RECORDED", evidence: EVIDENCE, recordedById: A }, { db: racing as never });
  assert.ok(res.ok && res.suppression === "lifted", "default behaviour, deliberately preserved for other callers");
  const other = await seed("p08b@x.com");
  const racing2 = racingDb("p08b@x.com", "BOUNCED", "beforeRead");
  const res2 = await recordMarketingConsent(other.id, { source: "ADMIN_RECORDED", evidence: EVIDENCE }, { db: racing2 as never });
  assert.deepEqual(res2, { ok: false, reason: "suppressed" }, "BOUNCED/COMPLAINED/ADMIN are never lifted by default either");
});

test("neverLiftSuppression refuses every active suppression, ends nothing, appends nothing, and changes nothing when there is none", async () => {
  for (const reason of SUPPRESSIONS) {
    const c = await seed(`n-${reason.toLowerCase()}@x.com`, { consent: true, suppress: reason });
    const before = JSON.stringify({ k: consents(c.email), s: suppressionOf(c.email) });
    for (const source of ["ADMIN_RECORDED", "SIGNUP_FORM", "CUSTOMER_ACCOUNT", "CSV_IMPORT"] as const) {
      const res = await recordMarketingConsent(c.id, { source, evidence: EVIDENCE }, { db: d(), neverLiftSuppression: true });
      assert.deepEqual(res, { ok: false, reason: "suppressed" }, `${reason}/${source}`);
    }
    assert.equal(JSON.stringify({ k: consents(c.email), s: suppressionOf(c.email) }), before);
  }
  const clean = await seed("clean@x.com");
  const ok = await recordMarketingConsent(clean.id, { source: "ADMIN_RECORDED", evidence: EVIDENCE, recordedById: A }, { db: d(), neverLiftSuppression: true });
  assert.ok(ok.ok && ok.created && ok.suppression === "none");
  const again = await recordMarketingConsent(clean.id, { source: "ADMIN_RECORDED", evidence: EVIDENCE }, { db: d(), neverLiftSuppression: true });
  assert.ok(again.ok && !again.created);
  assert.equal(consents("clean@x.com").length, 1, "append-only: an existing open consent is not duplicated or rewritten");
});

// ---------------------------------------------------------------------------------------------------------------------- CSV preview

test("preview validates and counts but writes NOTHING (no contact, consent, suppression or audit row)", async () => {
  await seed("exists@x.com");
  await seed("blocked@x.com", { suppress: "BOUNCED" });
  const before = snapshot();
  const res = await adminPreviewContactCsv(A, csvOf([
    `new1@x.com,New One,true,${EVIDENCE}`, "new2@x.com,New Two,,", "exists@x.com,Exists,,", `blocked@x.com,B,true,${EVIDENCE}`,
    "bad-address,Bad,,", "new1@x.com,Again,,", "maybe@x.com,M,yes,",
  ]), { db: d() });
  assert.ok(res.ok);
  const p = res.preview;
  assert.deepEqual([p.totalRows, p.validRows, p.invalidRows, p.duplicateRows], [7, 4, 2, 1]);
  assert.deepEqual([p.newContacts, p.existingContacts, p.consentRequested, p.consentBlocked], [2, 2, 2, 1]);
  assert.equal(p.rows.length, 7);
  assert.match(p.rows.find((r) => r.row === 2)!.outcome, /New contact, consent will be recorded/);
  assert.match(p.rows.find((r) => r.row === 5)!.outcome, /consent will be refused/);
  assert.match(p.rows.find((r) => r.row === 7)!.outcome, /duplicate of row 2/);
  assert.deepEqual(p.issues.map((i) => i.row).sort(), [6, 7, 8]);
  assert.equal(snapshot(), before);
  assert.equal(db.rows("adminAuditEvent").length, 0);
});

test("preview refuses a bad file with a message (not a crash) and caps the issue list", async () => {
  for (const bad of ["", "name\nA", "email,phone\na@x.com,1", 'email\n"open', 7, null]) {
    const res = await adminPreviewContactCsv(A, bad, { db: d() });
    assert.ok(!res.ok && res.message.length > 0, String(bad));
  }
  const many = await adminPreviewContactCsv(A, csvOf(Array.from({ length: 150 }, (_, i) => `bad${i},,,`)), { db: d() });
  assert.ok(many.ok);
  assert.equal(many.preview.invalidRows, 150);
  assert.equal(many.preview.issues.length, 100);
  assert.equal(many.preview.issuesTruncated, true);
  assert.equal(many.preview.rows.length, 25, "the preview table is bounded");
});

// ----------------------------------------------------------------------------------------------------------------------------- CSV import

test("an import WITHOUT consent columns creates contacts (CSV_IMPORT) and no consent at all", async () => {
  const res = await adminImportContactCsv(A, "email,name\nA@x.com,Ann\nb@x.com,\n", {}, { db: d() });
  assert.ok(res.ok);
  assert.deepEqual([res.summary.totalRows, res.summary.validRows, res.summary.newContacts, res.summary.consentRecorded], [2, 2, 2, 0]);
  assert.deepEqual(contacts().map((c) => [c.email, c.source, c.createdById]), [["a@x.com", "CSV_IMPORT", "admin-1"], ["b@x.com", "CSV_IMPORT", "admin-1"]]);
  assert.equal(consents().length, 0);
  assert.equal((await elig("a@x.com")).eligible, false);
  assert.equal(db.rows("emailJob").length, 0);
});

test("blank, false, missing and ambiguous consent never create consent (ambiguous rows are rejected whole)", async () => {
  const res = await adminImportContactCsv(A, csvOf([
    `blank@x.com,,,${EVIDENCE}`, `false@x.com,,FALSE,${EVIDENCE}`, "noev@x.com,,true,", "yes@x.com,,yes,Signed paper form on 2026-10-02", "short@x.com,,true,yes",
  ]), { attestConsent: true }, { db: d() });
  assert.ok(res.ok);
  assert.deepEqual([res.summary.validRows, res.summary.invalidRows, res.summary.consentRecorded], [2, 3, 0]);
  assert.deepEqual(contacts().map((c) => c.email).sort(), ["blank@x.com", "false@x.com"]);
  assert.equal(consents().length, 0);
});

test("explicit consent with evidence is recorded through recordMarketingConsent (CSV_IMPORT, with evidence and the admin) and the contact becomes eligible", async () => {
  const res = await runAs("admin", () => importEmailContactsCsvAction(csvOf([`opt@x.com,Opt,true,${EVIDENCE}`, "plain@x.com,Plain,,"]), true));
  assert.ok(res.success, JSON.stringify(res));
  const s = (res as any).summary;
  assert.deepEqual([s.newContacts, s.consentRecorded, s.consentBlocked, s.skippedOrBlocked], [2, 1, 0, 0]);
  const row = consents("opt@x.com")[0];
  assert.deepEqual([row.source, row.evidence, row.recordedById, row.unsubscribedAt ?? null], ["CSV_IMPORT", EVIDENCE, "admin-1", null]);
  assert.equal((await elig("opt@x.com")).eligible, true);
  assert.equal((await elig("plain@x.com")).eligible, false);
  assert.equal(consents("plain@x.com").length, 0);
});

test("rows that record consent need the admin's attestation; without it nothing is written, and a file with no consent rows needs none", async () => {
  const csv = csvOf([`opt@x.com,Opt,true,${EVIDENCE}`]);
  for (const attest of [undefined, false, "true", 1]) {
    const res = await adminImportContactCsv(A, csv, { attestConsent: attest }, { db: d() });
    assert.ok(!res.ok && /Confirm that you hold the consent/.test(res.message), String(attest));
  }
  assert.equal(contacts().length, 0);
  const noConsent = await adminImportContactCsv(A, csvOf(["plain@x.com,Plain,,"]), {}, { db: d() });
  assert.ok(noConsent.ok);
  const empty = await adminImportContactCsv(A, csvOf(["bad,,,"]), {}, { db: d() });
  assert.ok(!empty.ok && /no valid rows/i.test(empty.message));
  assert.equal(db.rows("adminAuditEvent").filter((e) => e.action === "email_contacts.csv_import").length, 1, "only the real import is audited");
});

test("duplicate rows: only the first occurrence is imported, a later consent statement is ignored, and the summary counts add up", async () => {
  const res = await adminImportContactCsv(A, csvOf([
    "dup@x.com,First,,", `DUP@x.com,Second,true,${EVIDENCE}`, "other@x.com,O,,", " dup@x.com ,Third,,", "bad,,,",
  ]), { attestConsent: true }, { db: d() });
  assert.ok(res.ok);
  const s = res.summary;
  assert.deepEqual([s.totalRows, s.validRows, s.invalidRows, s.duplicateRows], [5, 2, 1, 2]);
  assert.equal(s.totalRows, s.validRows + s.invalidRows + s.duplicateRows);
  assert.equal(contacts().find((c) => c.email === "dup@x.com")!.name, "First");
  assert.equal(consents().length, 0);
  assert.equal(s.skippedOrBlocked, 0);
});

test("existing contacts keep their source, status, consent and suppression; only a given name changes; the counts say what happened", async () => {
  await seed("old@x.com", { name: "Old Name", source: "MANUAL", consent: true });
  await seed("same@x.com", { name: "Same", consent: true });
  const consentBefore = JSON.stringify(consents());
  const res = await adminImportContactCsv(A, csvOf([`old@x.com,New Name,true,${EVIDENCE}`, "same@x.com,Same,,", "fresh@x.com,Fresh,,"]), { attestConsent: true }, { db: d() });
  assert.ok(res.ok);
  const s = res.summary;
  assert.deepEqual([s.newContacts, s.existingContacts, s.existingUpdated, s.consentRecorded, s.consentAlreadyOnFile], [1, 2, 1, 0, 1]);
  assert.equal(contacts().find((c) => c.email === "old@x.com")!.name, "New Name");
  assert.equal(contacts().find((c) => c.email === "old@x.com")!.source, "MANUAL");
  assert.equal(JSON.stringify(consents()), consentBefore, "no consent row was added or altered");
});

test("consent history is append-only: a re-import changes no row; after a withdrawal the new opt-in is a NEW row beside the old one", async () => {
  const c = await seed("hist@x.com", { consent: true });
  const first = consents("hist@x.com")[0];
  const again = await adminImportContactCsv(A, csvOf([`hist@x.com,,true,${EVIDENCE}`]), { attestConsent: true }, { db: d() });
  assert.ok(again.ok && again.summary.consentAlreadyOnFile === 1 && again.summary.consentRecorded === 0);
  assert.deepEqual(consents("hist@x.com"), [first]);

  await withdrawMarketingConsent(c.id, "CUSTOMER_ACCOUNT", { db: d(), now: at(-30) });
  const closed = consents("hist@x.com")[0];
  assert.ok(closed.unsubscribedAt);
  assert.equal((await elig("hist@x.com")).eligible, false);

  const renewed = await adminImportContactCsv(A, csvOf([`hist@x.com,,true,${EVIDENCE}`]), { attestConsent: true }, { db: d(), now: at(-10) });
  assert.ok(renewed.ok && renewed.summary.consentRecorded === 1);
  const rows = consents("hist@x.com");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((r) => r.id === first.id), closed, "the old row is exactly as it was");
  assert.equal(rows.filter((r) => r.unsubscribedAt == null).length, 1);
  assert.equal((await elig("hist@x.com")).eligible, true);
});

test("an import runs in bounded batches and stops cleanly at its time budget; the rest can be imported safely by running the file again", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => `u${i}@x.com,U${i},,`);
  let now = 0;
  const clock = () => (now += 100); // every look at the clock costs 100 ms
  const partial = await adminImportContactCsv(A, csvOf(rows), {}, { db: d(), batchSize: 2, deadlineMs: 250, clock });
  assert.ok(partial.ok);
  const s = partial.summary;
  assert.ok(s.newContacts > 0 && s.notProcessed > 0, JSON.stringify(s));
  assert.equal(s.newContacts + s.notProcessed, 7);
  assert.equal(s.skippedOrBlocked, s.notProcessed);
  assert.equal(contacts().length, s.newContacts);

  const rest = await adminImportContactCsv(A, csvOf(rows), {}, { db: d(), batchSize: 2 });
  assert.ok(rest.ok && rest.summary.notProcessed === 0);
  assert.equal(contacts().length, 7, "no duplicates after a second run");
  assert.equal(rest.summary.newContacts, 7 - s.newContacts);
});

test("one row failing does not stop the import, is counted, and leaks no database detail", async () => {
  const flaky: any = new Proxy(db, {
    get(target, key) {
      const value = (target as any)[key];
      if (key !== "emailContact") return typeof value === "function" ? value.bind(target) : value;
      return { ...value, findUnique: async (a: any) => { if (a?.where?.email === "boom@x.com") throw new Error("P1001 secret-host.internal:5432"); return value.findUnique(a); } };
    },
  });
  const res = await adminImportContactCsv(A, csvOf(["a@x.com,,,", "boom@x.com,,,", "c@x.com,,,"]), {}, { db: flaky });
  assert.ok(res.ok);
  assert.deepEqual([res.summary.newContacts, res.summary.failed, res.summary.skippedOrBlocked], [2, 1, 1]);
  assert.ok(!JSON.stringify(res.summary).includes("secret-host"));
  assert.deepEqual(contacts().map((c) => c.email).sort(), ["a@x.com", "c@x.com"]);
});

test("the import is recorded in the audit log with counts only (no addresses, names or evidence)", async () => {
  await adminImportContactCsv(A, csvOf([`secret.person@x.com,Secret Person,true,${EVIDENCE}`]), { attestConsent: true }, { db: d() });
  const [event] = db.rows("adminAuditEvent");
  assert.equal(event.action, "email_contacts.csv_import");
  assert.equal(event.actorId, A);
  const text = JSON.stringify(event);
  assert.ok(!/secret\.person|Secret Person|newsletter box/.test(text));
  assert.equal(event.detail.consentRecorded, 1);
  assert.equal(event.detail.consentAttested, true);
});

test("CSV cells are stored as plain text and never interpreted (formulas and markup are kept inert)", async () => {
  const res = await adminImportContactCsv(A, `email,name\nf@x.com,"=HYPERLINK(""http://evil"",""x"")"\nh@x.com,<img src=x onerror=alert(1)>\n`, {}, { db: d() });
  assert.ok(res.ok && res.summary.newContacts === 2);
  assert.equal(contacts()[0].name, '=HYPERLINK("http://evil","x")');
  assert.equal(contacts()[1].name, "<img src=x onerror=alert(1)>");
});

// ------------------------------------------------------------------------------------------------------------------------- list and filters

async function seedMix() {
  await seed("eligible@x.com", { name: "Eve Eligible", consent: true, minutes: 1 });
  await seed("noconsent@x.com", { name: "Nora None", minutes: 2 });
  await seed("unsub@x.com", { name: "Uma Unsub", consent: true, suppress: "UNSUBSCRIBED", minutes: 3 });
  await seed("bounced@x.com", { name: "Ben Bounced", consent: true, suppress: "BOUNCED", minutes: 4 });
  await seed("complained@x.com", { suppress: "COMPLAINED", minutes: 5 });
  await seed("blocked@x.com", { suppress: "ADMIN", minutes: 6 });
  await seed("inactive@x.com", { name: "Ian Inactive", consent: true, inactive: true, minutes: 7 });
  await seed("withdrawn@x.com", { withdrawn: true, minutes: 8 });
  await seed("csv@x.com", { source: "CSV_IMPORT", consent: true, minutes: 9 });
  await seed("c9@x.test", { source: "CUSTOMER", userId: "cust-9", minutes: 10 });
}
const emails = async (query: Record<string, unknown>) => (await adminListEmailContacts(A, query, { db: d() })).rows.map((r) => r.email).sort();

test("ineligible contacts are shown as such, with the service's reason, the consent state and the suppression reason", async () => {
  await seedMix();
  const list = await adminListEmailContacts(A, {}, { db: d() });
  const by = Object.fromEntries(list.rows.map((r) => [r.email, r]));
  assert.deepEqual([by["eligible@x.com"].eligibility, by["eligible@x.com"].consentStatus, by["eligible@x.com"].suppressionReason], [{ eligible: true }, "given", null]);
  assert.deepEqual([by["noconsent@x.com"].eligibility, by["noconsent@x.com"].consentStatus], [{ eligible: false, reason: "no_consent" }, "none"]);
  assert.deepEqual([by["unsub@x.com"].eligibility, by["unsub@x.com"].consentStatus, by["unsub@x.com"].suppressionReason], [{ eligible: false, reason: "suppressed" }, "unsubscribed", "UNSUBSCRIBED"]);
  assert.deepEqual([by["bounced@x.com"].eligibility, by["bounced@x.com"].suppressionReason], [{ eligible: false, reason: "suppressed" }, "BOUNCED"]);
  assert.equal(by["complained@x.com"].suppressionReason, "COMPLAINED");
  assert.equal(by["blocked@x.com"].suppressionReason, "ADMIN");
  assert.deepEqual([by["inactive@x.com"].eligibility, by["inactive@x.com"].isActive], [{ eligible: false, reason: "inactive" }, false]);
  assert.deepEqual([by["withdrawn@x.com"].eligibility, by["withdrawn@x.com"].consentStatus], [{ eligible: false, reason: "no_consent" }, "withdrawn"]);
  assert.deepEqual(by["c9@x.test"].customer, { id: "cust-9", name: "Customer Nine" });
  for (const row of list.rows) assert.deepEqual(row.eligibility, (({ eligible, reason }: any) => (eligible ? { eligible } : { eligible, reason }))(await elig(row.email)), `${row.email}: the row shows the eligibility service's verdict`);
});

test("each filter returns exactly its contacts", async () => {
  await seedMix();
  assert.equal((await emails({})).length, 10);
  assert.deepEqual(await emails({ filter: "eligible" }), ["csv@x.com", "eligible@x.com"]);
  assert.deepEqual(await emails({ filter: "no_consent" }), ["c9@x.test", "noconsent@x.com", "withdrawn@x.com"]);
  assert.deepEqual(await emails({ filter: "unsubscribed" }), ["unsub@x.com"]);
  assert.deepEqual(await emails({ filter: "suppressed" }), ["blocked@x.com", "bounced@x.com", "complained@x.com"]);
  assert.deepEqual(await emails({ filter: "inactive" }), ["inactive@x.com"]);
  assert.deepEqual(await emails({ filter: "csv" }), ["csv@x.com"]);
  assert.deepEqual(await emails({ filter: "customer" }), ["c9@x.test"]);
  assert.equal((await emails({ filter: "manual" })).length, 8);
  assert.equal((await emails({ filter: "nonsense" })).length, 10, "an unknown filter is 'all'");
});

test("the eligible filter shows candidates but each row still carries the eligibility service's verdict (a consent dated in the future is not eligible)", async () => {
  await seedMix();
  const csv = contacts().find((c) => c.email === "csv@x.com")!;
  const consent = db.rows("marketingConsent").find((k) => k.contactId === csv.id)!;
  db.patch("marketingConsent", consent.id, { grantedAt: new Date(Date.now() + 7 * 86_400_000) });
  const list = await adminListEmailContacts(A, { filter: "eligible" }, { db: d() });
  const row = list.rows.find((r) => r.email === "csv@x.com")!;
  assert.equal(row.eligibility.eligible, false, "the row is judged by the service, not by the narrowing query");
  assert.equal((await adminGetEmailContactStats(A, { db: d() })).eligible, 1, "and so is the stat");
});

test("search matches e-mail or name, any case, and survives odd input", async () => {
  await seedMix();
  assert.deepEqual(await emails({ q: "EVE" }), ["eligible@x.com"]);
  assert.deepEqual(await emails({ q: "ian inactive" }), ["inactive@x.com"]);
  assert.deepEqual(await emails({ q: "unsub@" }), ["unsub@x.com"]);
  assert.deepEqual(await emails({ q: "bounced", filter: "suppressed" }), ["bounced@x.com"]);
  assert.deepEqual(await emails({ q: "bounced", filter: "eligible" }), []);
  for (const odd of ["%", "_", "'; DROP TABLE x; --", "\u0000", "a".repeat(1000), { $ne: 1 }, ["x"], 5, null]) {
    const res = await adminListEmailContacts(A, { q: odd }, { db: d() });
    assert.ok(Array.isArray(res.rows), JSON.stringify(odd));
  }
});

test("pagination: 25 per page, newest first, the last page is the remainder, bad pages are clamped, filters and search keep paging consistent", async () => {
  for (let i = 0; i < 60; i++) await seed(`u${String(i).padStart(2, "0")}@x.com`, { consent: i % 2 === 0, minutes: i });
  const p1 = await adminListEmailContacts(A, { page: "1" }, { db: d() });
  assert.deepEqual([p1.rows.length, p1.total, p1.pageCount, p1.page, p1.pageSize], [25, 60, 3, 1, 25]);
  assert.equal(p1.rows[0].email, "u59@x.com", "newest first");
  assert.equal(p1.rows[24].email, "u35@x.com");
  const p3 = await adminListEmailContacts(A, { page: "3" }, { db: d() });
  assert.deepEqual([p3.rows.length, p3.rows[0].email, p3.rows[9].email], [10, "u09@x.com", "u00@x.com"]);
  const seen = new Set<string>();
  for (const page of ["1", "2", "3"]) for (const r of (await adminListEmailContacts(A, { page }, { db: d() })).rows) seen.add(r.email);
  assert.equal(seen.size, 60, "no row is repeated or missed across pages");
  for (const bad of ["99", "0", "-3", "abc", undefined, "2.5"]) {
    const res = await adminListEmailContacts(A, { page: bad }, { db: d() });
    assert.ok(res.page >= 1 && res.page <= 3 && res.rows.length > 0, String(bad));
  }
  assert.equal((await adminListEmailContacts(A, { page: "99" }, { db: d() })).page, 3);
  const eligible = await adminListEmailContacts(A, { filter: "eligible", page: "2" }, { db: d() });
  assert.deepEqual([eligible.total, eligible.pageCount, eligible.rows.length], [30, 2, 5]);
  const searched = await adminListEmailContacts(A, { q: "u5" }, { db: d() });
  assert.equal(searched.total, 10);
  const empty = await adminListEmailContacts(A, { q: "no-such-person" }, { db: d() });
  assert.deepEqual([empty.total, empty.pageCount, empty.page, empty.rows.length], [0, 1, 1, 0]);
});

test("the stat cards count total, eligible, unsubscribed, suppressed and inactive contacts", async () => {
  await seedMix();
  const s = await adminGetEmailContactStats(A, { db: d() });
  assert.deepEqual(s, { total: 10, eligible: 2, eligibleChecked: true, unsubscribed: 1, suppressed: 3, inactive: 1 });
  const capped = await adminGetEmailContactStats(A, { db: d(), eligibilityCap: 1 });
  assert.deepEqual([capped.eligible, capped.eligibleChecked], [2, false], "beyond the checked sample the figure is flagged as an estimate");
});

// ----------------------------------------------------------------------------------------------------------------------------- details

test("the details view shows contact, source, customer, consent history (source, evidence, times), suppression and eligibility, and never the token hash", async () => {
  const c = await seed("who@x.com", { name: "Who" });
  db.patch("emailContact", c.id, { source: "CUSTOMER", unsubscribeTokenHash: "a".repeat(64), userId: "cust-9", createdById: A });
  await recordMarketingConsent(c.id, { source: "ADMIN_RECORDED", evidence: EVIDENCE, recordedById: A }, { db: d(), now: at(-100) });
  await suppressEmail("who@x.com", { reason: "BOUNCED", note: "mailbox full" }, { db: d(), now: at(-50) });
  await recordMarketingConsent(c.id, { source: "SIGNUP_FORM" }, { db: d(), now: at(-10) }); // refused: BOUNCED blocks any new consent

  const detail = await adminGetEmailContactDetail(A, c.id, { db: d() });
  assert.ok(detail);
  assert.deepEqual([detail.email, detail.name, detail.source, detail.isActive, detail.createdBy], ["who@x.com", "Who", "CUSTOMER", true, "admin-1"]);
  assert.deepEqual(detail.customer, { id: "cust-9", name: "Customer Nine", email: "c9@x.test" });
  assert.equal(detail.consents.length, 1);
  assert.deepEqual([detail.consents[0].source, detail.consents[0].evidence, detail.consents[0].recordedBy, detail.consents[0].open, detail.consents[0].unsubscribeSource], ["ADMIN_RECORDED", EVIDENCE, "admin-1", false, "BOUNCE"]);
  assert.ok(detail.consents[0].grantedAt && detail.consents[0].unsubscribedAt);
  assert.deepEqual([detail.suppression?.reason, detail.suppression?.active, detail.suppression?.note, detail.suppression?.liftedAt], ["BOUNCED", true, "mailbox full", null]);
  assert.deepEqual(detail.eligibility, { eligible: false, reason: "suppressed" });
  assert.equal(detail.consentStatus, "withdrawn");
  assert.ok(!JSON.stringify(detail).includes("a".repeat(64)) && !/unsubscribeTokenHash/i.test(JSON.stringify(detail)));
});

test("a lifted unsubscribe shows as lifted history with the new consent beside it", async () => {
  const c = await seed("back@x.com", { consent: true, suppress: "UNSUBSCRIBED" });
  const lifted = await recordMarketingConsent(c.id, { source: "SIGNUP_FORM" }, { db: d(), now: at(5) }); // the customer's own sign-up: allowed to lift an unsubscribe
  assert.ok(lifted.ok && lifted.suppression === "lifted");
  const detail = await adminGetEmailContactDetail(A, c.id, { db: d() });
  assert.ok(detail);
  assert.deepEqual([detail.suppression?.active, detail.suppression?.liftedAt != null, detail.consents.length, detail.consents.filter((k) => k.open).length], [false, true, 2, 1]);
  assert.deepEqual(detail.eligibility, { eligible: true });
});

test("an unknown or malformed contact id gives null, never an error page with detail", async () => {
  for (const id of ["nope", "", "a/b", "x".repeat(100), null, undefined, 5, { id: 1 }]) assert.equal(await adminGetEmailContactDetail(A, id, { db: d() }), null, String(id));
});

// ---------------------------------------------------------------------------------------------------------------------- activate / deactivate

test("activation and deactivation use the existing service and change nothing else: consent and suppression stay exactly as they were", async () => {
  const c = await seed("tog@x.com", { consent: true });
  const s = await seed("tog2@x.com", { consent: true, suppress: "COMPLAINED" });
  const before = JSON.stringify({ k: db.rows("marketingConsent"), s: db.rows("emailSuppression") });

  assert.deepEqual(await runAs("admin", () => setEmailContactActiveAction(c.id, false)), { success: true });
  assert.equal(db.get("emailContact", c.id).isActive, false);
  assert.deepEqual(await elig("tog@x.com"), { eligible: false, reason: "inactive" });
  assert.deepEqual(await runAs("admin", () => setEmailContactActiveAction(c.id, true)), { success: true });
  assert.deepEqual(await elig("tog@x.com"), { eligible: true, consentId: db.rows("marketingConsent")[0].id });

  await runAs("admin", () => setEmailContactActiveAction(s.id, false));
  await runAs("admin", () => setEmailContactActiveAction(s.id, true));
  assert.deepEqual(await elig("tog2@x.com"), { eligible: false, reason: "suppressed" }, "reactivating a suppressed contact restores nothing");
  assert.equal(JSON.stringify({ k: db.rows("marketingConsent"), s: db.rows("emailSuppression") }), before);
});

test("activation refuses a bad id or value with a message; the bulk form is bounded and counts what it did", async () => {
  const a = await seed("a@x.com");
  const b = await seed("b@x.com");
  for (const bad of [["nope", true], [null, true], ["", false], [a.id, "yes"], [a.id, undefined]] as [unknown, unknown][]) {
    const res = await runAs("admin", () => setEmailContactActiveAction(bad[0], bad[1]));
    assert.equal(res.success, false, JSON.stringify(bad));
  }
  const ok = await runAs("admin", () => setEmailContactsActiveAction([a.id, b.id, a.id, "ghost1"], false));
  assert.deepEqual(ok, { success: true, updated: 2, missing: 1 });
  assert.deepEqual(contacts().map((c) => c.isActive), [false, false]);
  for (const bad of [[], "x", null, ["a/b"], Array.from({ length: 101 }, (_, i) => `id${i}`)] as unknown[]) {
    assert.equal((await runAs("admin", () => setEmailContactsActiveAction(bad, true))).success, false);
  }
  assert.deepEqual(contacts().map((c) => c.isActive), [false, false], "a refused bulk request changes nothing");
});
