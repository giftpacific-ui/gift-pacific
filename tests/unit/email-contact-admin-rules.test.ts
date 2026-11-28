/**
 * P12-UI-01: the pure rules behind Email marketing > Contacts: list-query parsing, the CSV parser (as DATA), header and row validation, duplicate
 * detection, the consent-evidence rule and the spreadsheet-formula display guard. No database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkConsentEvidence, checkCsvHeader, parseContactFilter, parseContactPage, parseContactSearch, parseCsv, planCsv, readConsentCell,
} from "@/lib/email/contact-admin-rules";
import { CONTACT_FILTERS, CSV_COLUMNS, MAX_CSV_BYTES, MAX_CSV_ROWS, csvSafe } from "@/lib/email-contacts";

const plan = (csv: string) => {
  const p = planCsv(parseCsv(csv));
  assert.ok(p.ok, JSON.stringify(p));
  return p.rows;
};
const EVIDENCE = "Ticked the newsletter box on the 2026 sign-up sheet";

// ------------------------------------------------------------------------------------------------------------------------------ list query

test("the filter is one of the nine known values; anything else is 'all'", () => {
  assert.deepEqual(CONTACT_FILTERS.map((f) => f.value), ["all", "eligible", "no_consent", "unsubscribed", "suppressed", "inactive", "manual", "csv", "customer"]);
  for (const f of CONTACT_FILTERS) assert.equal(parseContactFilter(f.value), f.value);
  for (const bad of ["ELIGIBLE", "everyone", "", null, undefined, 5, ["eligible"], { value: "eligible" }]) assert.equal(parseContactFilter(bad), "all", String(bad));
});

test("the page number is a bounded positive integer; the search text is flattened and capped", () => {
  assert.equal(parseContactPage("3"), 3);
  for (const bad of ["0", "-1", "1.5", "abc", "", "1e3", "9999999999", undefined, null, NaN]) assert.equal(parseContactPage(bad), 1, String(bad));
  assert.equal(parseContactPage("10000"), 10000);
  assert.equal(parseContactPage("999999"), 10000, "a large page is clamped to the maximum");
  assert.equal(parseContactSearch("  jane \n\t doe  "), "jane doe");
  assert.equal(parseContactSearch("a\u0000b"), "a b");
  assert.equal(parseContactSearch("x".repeat(500)).length, 100);
  assert.equal(parseContactSearch(undefined), "");
  assert.equal(parseContactSearch({ q: 1 }), "");
});

// --------------------------------------------------------------------------------------------------------------------------- consent evidence

test("consent evidence must be present, meaningful (not 'yes') and within the stored limit; it is never cut", () => {
  assert.equal(checkConsentEvidence(undefined).ok, false);
  assert.equal(checkConsentEvidence("   ").ok, false);
  for (const weak of ["yes", "true", "ok", "agreed"]) assert.equal(checkConsentEvidence(weak).ok, false, weak);
  const good = checkConsentEvidence("  Signed   paper form, 12 Oct  ");
  assert.deepEqual(good, { ok: true, value: "Signed paper form, 12 Oct" });
  assert.equal(checkConsentEvidence("x".repeat(500)).ok, true);
  assert.equal(checkConsentEvidence("x".repeat(501)).ok, false);
  assert.equal(checkConsentEvidence(42).ok, false);
});

test("the consent cell: blank, true, false (any case) only; everything else is ambiguous, never guessed", () => {
  assert.deepEqual(readConsentCell(""), { ok: true, value: "blank" });
  assert.deepEqual(readConsentCell("  "), { ok: true, value: "blank" });
  assert.deepEqual(readConsentCell(" TRUE "), { ok: true, value: "true" });
  assert.deepEqual(readConsentCell("False"), { ok: true, value: "false" });
  for (const ambiguous of ["yes", "y", "1", "0", "no", "maybe", "on", "consented", "true;", "t"]) assert.deepEqual(readConsentCell(ambiguous), { ok: false }, ambiguous);
});

// -------------------------------------------------------------------------------------------------------------------------------- CSV parser

test("the parser handles quotes, embedded commas and line breaks, CRLF, a BOM and blank lines, and numbers rows like a spreadsheet", () => {
  const csv = `\uFEFFemail,name\r\na@x.com,"Doe, Jane"\r\n\r\nb@x.com,"Line one\nLine two"\r\nc@x.com,"She said ""hi"""\r\n`;
  const parsed = parseCsv(csv);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.header, ["email", "name"]);
  assert.deepEqual(parsed.records.map((r) => [r.row, r.cells]), [
    [2, ["a@x.com", "Doe, Jane"]],
    [4, ["b@x.com", "Line one\nLine two"]],
    [5, ["c@x.com", 'She said "hi"']],
  ]);
});

test("header validation: email required, only known columns, no repeats, matched case-insensitively", () => {
  assert.deepEqual([...CSV_COLUMNS], ["email", "name", "marketing_consent", "consent_evidence"]);
  assert.equal(parseCsv("Email, NAME \na@x.com,A").ok, true);
  const noEmail = parseCsv("name\nA");
  assert.ok(!noEmail.ok && /Missing required column: email/.test(noEmail.message));
  const unknown = parseCsv("email,phone\na@x.com,017");
  assert.ok(!unknown.ok && /Unknown column "phone"/.test(unknown.message));
  const semicolons = parseCsv("email;name\na@x.com;A");
  assert.ok(!semicolons.ok && /separated by commas/.test(semicolons.message));
  const dup = parseCsv("email,email\na@x.com,b@x.com");
  assert.ok(!dup.ok && /more than once/.test(dup.message));
  assert.equal(checkCsvHeader(["email"]).ok, true);
  assert.equal(checkCsvHeader([]).ok, false);
});

test("malformed or hostile files are refused as a whole, with a plain message", () => {
  for (const [csv, re] of [
    ["", /empty/i], ["   \n\n", /empty/i], [42, /Choose a CSV file/], [null, /Choose a CSV file/],
    ['email\n"unterminated', /never closed/], ['email\n"a"b@x.com', /after a closing quote/], ['email\na"b@x.com', /quote inside an unquoted cell/],
    ["email\na@x.com\u0000", /binary/],
  ] as [unknown, RegExp][]) {
    const r = parseCsv(csv);
    assert.ok(!r.ok && re.test(r.message), `${JSON.stringify(csv)} -> ${JSON.stringify(r)}`);
  }
});

test("size limits are enforced while reading: too many bytes, too many rows", () => {
  const big = parseCsv(`email\n${"a".repeat(MAX_CSV_BYTES)}`);
  assert.ok(!big.ok && /too large/.test(big.message));
  const rows = `email\n${Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `u${i}@x.com`).join("\n")}`;
  const many = parseCsv(rows);
  assert.ok(!many.ok && /Too many rows/.test(many.message));
  const exact = parseCsv(`email\n${Array.from({ length: MAX_CSV_ROWS }, (_, i) => `u${i}@x.com`).join("\n")}`);
  assert.ok(exact.ok && exact.records.length === MAX_CSV_ROWS);
});

// ---------------------------------------------------------------------------------------------------------------------------------- row plan

test("valid rows are normalised; consent is requested ONLY by an explicit true with adequate evidence", () => {
  const rows = plan(`email,name,marketing_consent,consent_evidence\n  Jane@Example.COM ,  Jane   Doe ,TRUE,${EVIDENCE}\nplain@x.com,Plain,,\nno@x.com,No,false,${EVIDENCE}\n`);
  assert.deepEqual(rows.map((r) => [r.status, r.email, r.name, r.consent]), [
    ["valid", "jane@example.com", "Jane Doe", "explicit"],
    ["valid", "plain@x.com", "Plain", "none"],
    ["valid", "no@x.com", "No", "none"], // false + evidence: no consent, evidence ignored
  ]);
  assert.equal(rows[0].evidence, EVIDENCE);
  assert.equal(rows[2].evidence, null);
});

test("an import of addresses alone never requests consent (no consent columns at all)", () => {
  const rows = plan("email\na@x.com\nb@x.com\n");
  assert.ok(rows.every((r) => r.status === "valid" && r.consent === "none" && r.evidence === null));
});

test("row validation: bad address, missing address, ambiguous consent, true without evidence, oversized name, extra cells, oversized cell", () => {
  const rows = plan([
    "email,name,marketing_consent,consent_evidence",
    "not-an-address,A,,",
    ",B,,",
    "c@x.com,C,yes,",
    `d@x.com,D,true,`,
    `e@x.com,D,true,yes`,
    `f@x.com,${"n".repeat(201)},,`,
    "g@x.com,G,,,extra",
    `h@x.com,${"z".repeat(1500)},,`,
    "ok@x.com,Fine,,",
  ].join("\n"));
  assert.deepEqual(rows.map((r) => r.status), ["invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "valid"]);
  assert.match(rows[0].issues[0], /not valid/);
  assert.match(rows[1].issues[0], /missing/);
  assert.match(rows[2].issues[0], /true, false or empty/);
  assert.match(rows[3].issues[0], /evidence is required/);
  assert.match(rows[4].issues[0], /too short/);
  assert.match(rows[5].issues[0], /longer than 200/);
  assert.match(rows[6].issues[0], /more cells/);
  assert.match(rows[7].issues[0], /longer than 1000/);
  assert.ok(rows.slice(0, 8).every((r) => r.consent === "none" && r.evidence === null), "an invalid row can never carry consent");
  assert.equal(rows[7].name, null, "an oversized value is never stored, cut or not");
});

test("duplicates: the first occurrence wins (any case/spacing), later ones are duplicates and carry no consent", () => {
  const rows = plan(`email,name,marketing_consent,consent_evidence\nDup@X.com,First,,\n dup@x.com ,Second,true,${EVIDENCE}\nother@x.com,O,,\nDUP@x.com,Third,,\n`);
  assert.deepEqual(rows.map((r) => [r.row, r.status, r.duplicateOf ?? null]), [[2, "valid", null], [3, "duplicate", 2], [4, "valid", null], [5, "duplicate", 2]]);
  assert.equal(rows[1].consent, "none", "a duplicate row's consent statement is not used");
  assert.match(rows[1].issues[0], /row 2/);
});

test("an invalid row that repeats a valid address is invalid, not a duplicate, and does not hide the real row", () => {
  const rows = plan("email,marketing_consent\na@x.com,maybe\na@x.com,\n");
  assert.deepEqual(rows.map((r) => r.status), ["invalid", "valid"]);
});

test("cells are data: formulas, HTML and script text are kept as plain text and never interpreted", () => {
  const rows = plan(`email,name\nx@x.com,"=HYPERLINK(""http://evil"",""x"")"\ny@x.com,<script>alert(1)</script>\n`);
  assert.equal(rows[0].name, '=HYPERLINK("http://evil","x")');
  assert.equal(rows[1].name, "<script>alert(1)</script>");
});

// -------------------------------------------------------------------------------------------------------------------------- formula guard

test("csvSafe neutralises spreadsheet formulas without changing safe text", () => {
  for (const hostile of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "=HYPERLINK(\"http://x\")"]) assert.equal(csvSafe(hostile), `'${hostile}`, hostile);
  for (const safe of ["Jane Doe", "a=b", "x+y", "user@x.com", " =not first", "", "0"]) assert.equal(csvSafe(safe), safe, safe);
  for (const notText of [null, undefined, 5, {}, ["=1"]]) assert.equal(csvSafe(notText), "");
});

test("the UI code renders CSV-derived text only through csvSafe", () => {
  const files = [
    "src/features/admin/email-contacts/contacts-table.tsx",
    "src/features/admin/email-contacts/import-csv-dialog.tsx",
    "src/app/admin/(dashboard)/email-marketing/contacts/[id]/page.tsx",
  ];
  for (const f of files) assert.match(readFileSync(f, "utf8"), /csvSafe\(/, f);
});
