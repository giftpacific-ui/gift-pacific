/**
 * Admin contact management rules (P12-UI-01). PURE: no database, no network, no secrets. Parses the list query, parses a CSV file as DATA (never as
 * instructions) and turns it into a per-row plan the service executes. Built on the shared marketing rules; it adds no eligibility rule of its own
 * (eligibility is always decided by getMarketingEligibility) and never grants consent by itself: a row only REQUESTS consent, and only with an explicit
 * `true` and adequate evidence. Server-side only like the rest of src/lib/email.
 */
import { normalizeContactEmail } from "@/lib/email/marketing";
import { cleanOptionalText, MAX_EVIDENCE_LENGTH, MAX_NAME_LENGTH } from "@/lib/email/marketing-rules";
import {
  CONTACT_FILTERS, CSV_COLUMNS, CSV_REQUIRED_COLUMNS, MAX_CONTACTS_PAGE, MAX_CSV_BYTES, MAX_CSV_CELL_LENGTH, MAX_CSV_ROWS, MAX_SEARCH_LENGTH, MIN_CONSENT_EVIDENCE_LENGTH,
  type ContactFilter,
} from "@/lib/email-contacts";

// ------------------------------------------------------------------------------------------------------------------------------ list query

export function parseContactFilter(raw: unknown): ContactFilter {
  return CONTACT_FILTERS.find((f) => f.value === raw)?.value ?? "all";
}

export function parseContactPage(raw: unknown): number {
  const n = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : 1;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CONTACTS_PAGE) : 1;
}

/** Search text: control characters become spaces, whitespace collapses, and the length is capped (a search is not a stored value, so cutting it is safe). */
export function parseContactSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const flat = Array.from(raw, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  return flat.slice(0, MAX_SEARCH_LENGTH);
}

// ------------------------------------------------------------------------------------------------------------------------------ consent text

/** Evidence an admin typed for a consent they are recording: required, long enough to mean something, never cut. */
export function checkConsentEvidence(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const cleaned = cleanOptionalText(raw, MAX_EVIDENCE_LENGTH);
  if (!cleaned.ok) return { ok: false, message: `Consent evidence can be at most ${MAX_EVIDENCE_LENGTH} characters.` };
  if (!cleaned.value) return { ok: false, message: "Consent evidence is required: say how and when the person agreed to receive marketing e-mail." };
  if (cleaned.value.length < MIN_CONSENT_EVIDENCE_LENGTH) return { ok: false, message: `Consent evidence is too short (at least ${MIN_CONSENT_EVIDENCE_LENGTH} characters). Describe how and when the person agreed.` };
  return { ok: true, value: cleaned.value };
}

// ------------------------------------------------------------------------------------------------------------------------------- CSV parser

type Record_ = { row: number; cells: string[]; oversized: boolean };
export type CsvParseResult = { ok: true; header: string[]; records: Record_[] } | { ok: false; message: string };

/**
 * RFC 4180 style: comma separated, double-quote quoting with "" as an escaped quote, CRLF/LF/CR line ends, quoted cells may hold commas and line
 * breaks. A UTF-8 byte-order mark is ignored. It is a plain state machine over the characters: nothing is evaluated, no regular expression runs on
 * the file, and the work is bounded (bytes, rows and cell length are limited, and the limits are checked while reading, not after).
 * `row` numbers follow the spreadsheet: the header is row 1. Entirely blank lines are skipped.
 */
export function parseCsv(input: unknown): CsvParseResult {
  if (typeof input !== "string") return { ok: false, message: "Choose a CSV file." };
  if (Buffer.byteLength(input, "utf8") > MAX_CSV_BYTES) return { ok: false, message: `The file is too large (the limit is ${Math.floor(MAX_CSV_BYTES / 1000)} KB). Split it into smaller files.` };
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.includes("\u0000")) return { ok: false, message: "This does not look like a text CSV file (it contains binary data)." };
  if (!text.trim()) return { ok: false, message: "The file is empty." };

  const all: { row: number; cells: string[]; oversized: boolean }[] = [];
  let recordNo = 0; // spreadsheet row of the record being read (blank lines count, so numbers match what the admin sees)
  let cells: string[] = [];
  let cell = "";
  let oversized = false;
  let inQuotes = false;
  let justClosed = false; // a quoted cell just ended: only a comma, a line end or the end of the file may follow
  let touched = false; // the current record has any content or separator
  const endCell = () => { cells.push(cell); cell = ""; justClosed = false; };
  const endRecord = () => {
    endCell();
    recordNo++;
    if (touched) all.push({ row: recordNo, cells, oversized });
    cells = []; oversized = false; touched = false;
  };
  const add = (ch: string) => { if (cell.length < MAX_CSV_CELL_LENGTH + 1) cell += ch; else oversized = true; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") { add("\""); i++; } else { inQuotes = false; justClosed = true; }
      } else add(ch);
      continue;
    }
    if (justClosed && ch !== "," && ch !== "\n" && ch !== "\r") return { ok: false, message: "The file is malformed: unexpected text after a closing quote." };
    if (ch === "\"") {
      if (cell.length > 0) return { ok: false, message: "The file is malformed: a quote inside an unquoted cell." };
      inQuotes = true; touched = true;
    } else if (ch === ",") { touched = true; endCell(); }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      if (all.length > MAX_CSV_ROWS + 1) return { ok: false, message: `Too many rows (the limit is ${MAX_CSV_ROWS.toLocaleString("en-US")} per import). Split the file.` };
    } else { if (ch.trim() !== "" || cell.length > 0 || cells.length > 0) touched = true; add(ch); }
  }
  if (inQuotes) return { ok: false, message: "The file is malformed: a quoted cell is never closed." };
  endRecord();
  if (all.length > MAX_CSV_ROWS + 1) return { ok: false, message: `Too many rows (the limit is ${MAX_CSV_ROWS.toLocaleString("en-US")} per import). Split the file.` };
  if (!all.length) return { ok: false, message: "The file is empty." };

  const rawHeader = all[0];
  if (rawHeader.oversized) return { ok: false, message: "The header row is not valid." };
  const header = rawHeader.cells.map((h) => h.trim().toLowerCase());
  const headerCheck = checkCsvHeader(header);
  if (!headerCheck.ok) return headerCheck;
  return { ok: true, header, records: all.slice(1) };
}

/** Column validation: `email` is required, every column must be a known one, none may repeat. Unknown columns are refused rather than silently ignored. */
export function checkCsvHeader(header: string[]): { ok: true } | { ok: false; message: string } {
  const known = CSV_COLUMNS as readonly string[];
  const unknown = header.filter((h) => !known.includes(h));
  if (unknown.length) {
    const shown = unknown.slice(0, 5).map((h) => (h ? `"${h.slice(0, 40)}"` : "(blank)")).join(", ");
    return { ok: false, message: `Unknown column ${shown}. Allowed columns: ${CSV_COLUMNS.join(", ")}. (Columns must be separated by commas.)` };
  }
  const dup = header.find((h, i) => header.indexOf(h) !== i);
  if (dup) return { ok: false, message: `The column "${dup}" appears more than once.` };
  const missing = CSV_REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return { ok: false, message: `Missing required column: ${missing.join(", ")}.` };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------------------------------------- row plan

export type CsvRowPlan = {
  row: number;
  status: "valid" | "invalid" | "duplicate";
  /** The normalised address for valid and duplicate rows; for an invalid row, the raw text (cut for display only). */
  email: string;
  name: string | null;
  /** "explicit": marketing_consent was exactly true AND the evidence is adequate. Everything else is "none". */
  consent: "explicit" | "none";
  evidence: string | null;
  issues: string[];
  duplicateOf?: number;
};
export type CsvPlan = { ok: true; rows: CsvRowPlan[] } | { ok: false; message: string };

const cellOf = (rec: { cells: string[] }, header: string[], col: string): string => {
  const i = header.indexOf(col);
  return i < 0 ? "" : (rec.cells[i] ?? "");
};

/**
 * marketing_consent: blank = no statement; "true"/"false" (any case) are the only other accepted values. Anything else ("yes", "1", "maybe"...) is
 * AMBIGUOUS and makes the row invalid: it is never guessed into consent, and never quietly dropped.
 */
export function readConsentCell(raw: string): { ok: true; value: "true" | "false" | "blank" } | { ok: false } {
  const v = raw.trim().toLowerCase();
  if (v === "") return { ok: true, value: "blank" };
  if (v === "true") return { ok: true, value: "true" };
  if (v === "false") return { ok: true, value: "false" };
  return { ok: false };
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Validates every row of a parsed file and finds duplicates (the FIRST occurrence of an address wins; later ones are duplicates and are not imported). */
export function planCsv(parsed: CsvParseResult): CsvPlan {
  if (!parsed.ok) return parsed;
  const { header, records } = parsed;
  const seen = new Map<string, number>();
  const rows: CsvRowPlan[] = records.map((rec) => {
    const issues: string[] = [];
    const rawEmail = cellOf(rec, header, "email");
    const rawName = cellOf(rec, header, "name");
    const rawConsent = cellOf(rec, header, "marketing_consent");
    const rawEvidence = cellOf(rec, header, "consent_evidence");

    if (rec.oversized) issues.push(`A cell is longer than ${MAX_CSV_CELL_LENGTH} characters.`);
    if (rec.cells.length > header.length) issues.push("The row has more cells than the header has columns.");

    const email = normalizeContactEmail(rawEmail);
    if (!email.ok) issues.push(rawEmail.trim() ? "The e-mail address is not valid." : "The e-mail address is missing.");

    const name = cleanOptionalText(rawName, MAX_NAME_LENGTH);
    if (!name.ok) issues.push(`The name is longer than ${MAX_NAME_LENGTH} characters.`);

    const consent = readConsentCell(rawConsent);
    if (!consent.ok) issues.push("marketing_consent must be true, false or empty.");

    let evidence: string | null = null;
    let wantsConsent = false;
    if (consent.ok && consent.value === "true") {
      const checked = checkConsentEvidence(rawEvidence);
      if (!checked.ok) issues.push(`marketing_consent is true but ${checked.message.charAt(0).toLowerCase()}${checked.message.slice(1)}`);
      else { evidence = checked.value; wantsConsent = true; }
    }

    const base = { row: rec.row, name: name.ok ? name.value : null, consent: wantsConsent ? ("explicit" as const) : ("none" as const), evidence };
    if (issues.length || !email.ok) return { ...base, status: "invalid" as const, email: clip(rawEmail.trim()), consent: "none" as const, evidence: null, issues };
    const first = seen.get(email.email);
    if (first !== undefined) return { ...base, status: "duplicate" as const, email: email.email, consent: "none" as const, evidence: null, issues: [`Same address as row ${first}; only the first row is used.`], duplicateOf: first };
    seen.set(email.email, rec.row);
    return { ...base, status: "valid" as const, email: email.email, issues: [] };
  });
  return { ok: true, rows };
}
