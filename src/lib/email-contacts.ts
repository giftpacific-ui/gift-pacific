/**
 * Subscriber & contact management (P12-UI-01): constants, labels, DTO types and the display guard shared by the admin contacts pages, their
 * client components and the server code behind them. PURE and BROWSER-SAFE: no database, no Node-only imports, no secrets. (The CSV parser and
 * validation live in lib/email/contact-admin-rules.ts, which is server-side only like the rest of lib/email.)
 */

export const CONTACT_FILTERS = [
  { value: "all", label: "All contacts" },
  { value: "eligible", label: "Eligible subscribers" },
  { value: "no_consent", label: "No consent" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "suppressed", label: "Suppressed" },
  { value: "inactive", label: "Inactive" },
  { value: "manual", label: "Manual contacts" },
  { value: "csv", label: "CSV imported" },
  { value: "customer", label: "Existing customers" },
] as const;
export type ContactFilter = (typeof CONTACT_FILTERS)[number]["value"];

export const CONTACTS_PAGE_SIZE = 25;
export const MAX_CONTACTS_PAGE = 10_000;
export const MAX_SEARCH_LENGTH = 100;

// ------------------------------------------------------------------------------------------------------------------------ consent evidence
/** "yes", "true" or "ok" is not evidence. The text must say how consent was obtained (form, date, channel, file...). */
export const MIN_CONSENT_EVIDENCE_LENGTH = 8;

// ------------------------------------------------------------------------------------------------------------------------------- CSV import
export const CSV_COLUMNS = ["email", "name", "marketing_consent", "consent_evidence"] as const;
export const CSV_REQUIRED_COLUMNS = ["email"] as const;
/** The whole request travels as one server-action body (Next's default limit is 1 MB), so the file is kept well below it. */
export const MAX_CSV_BYTES = 700_000;
export const MAX_CSV_ROWS = 2_000;
/** A single cell longer than this is flagged on its row and never stored (the real per-field limits are stricter). */
export const MAX_CSV_CELL_LENGTH = 1_000;
export const CSV_PREVIEW_ROWS = 25;
export const CSV_ISSUE_LIMIT = 100;
export const CSV_TEMPLATE = "email,name,marketing_consent,consent_evidence\njane@example.com,Jane Doe,true,Signed the marketing opt-in line on the 2026-10-02 sign-up sheet\nsam@example.com,Sam Roy,,\n";

// ------------------------------------------------------------------------------------------------------------------------------- labels
export const SOURCE_LABEL: Record<string, string> = { MANUAL: "Manual", CSV_IMPORT: "CSV import", CUSTOMER: "Customer" };
export const CONSENT_SOURCE_LABEL: Record<string, string> = {
  ADMIN_RECORDED: "Recorded by an admin", CSV_IMPORT: "CSV import", CUSTOMER_ACCOUNT: "Customer account",
  CHECKOUT_MARKETING: "Checkout marketing tick-box", SIGNUP_FORM: "Sign-up form",
};
export const UNSUBSCRIBE_SOURCE_LABEL: Record<string, string> = {
  LINK: "Unsubscribe link", ADMIN: "Admin", CUSTOMER_ACCOUNT: "Customer account", BOUNCE: "Bounce", COMPLAINT: "Complaint",
};
export const SUPPRESSION_LABEL: Record<string, string> = { UNSUBSCRIBED: "Unsubscribed", BOUNCED: "Bounced", COMPLAINED: "Complained", ADMIN: "Blocked by admin" };
export const CONSENT_STATUS_LABEL = { given: "Consent on file", unsubscribed: "Unsubscribed", withdrawn: "Consent withdrawn", none: "No consent" } as const;
export type ConsentStatus = keyof typeof CONSENT_STATUS_LABEL;
/** Why an address is not eligible, in words an admin can act on. Keys are the fixed MarketingSkipReason vocabulary. */
export const INELIGIBLE_LABEL: Record<string, string> = {
  invalid_email: "Not a valid address", no_contact: "No contact record", suppressed: "Suppressed", inactive: "Contact is inactive",
  no_consent: "No marketing consent", unverifiable: "Could not be verified",
};

// -------------------------------------------------------------------------------------------------------------------------- DTO types
export type EligibilityView = { eligible: true } | { eligible: false; reason: string };

export type ContactListRow = {
  id: string;
  email: string;
  name: string | null;
  source: string;
  isActive: boolean;
  createdAt: string;
  customer: { id: string; name: string } | null;
  consentStatus: ConsentStatus;
  suppressionReason: string | null;
  eligibility: EligibilityView;
};

export type ContactStats = {
  total: number;
  eligible: number;
  /** false when more contacts matched than were individually checked; the figure is then an estimate. */
  eligibleChecked: boolean;
  unsubscribed: number;
  suppressed: number;
  inactive: number;
};

export type ContactListResult = { rows: ContactListRow[]; total: number; page: number; pageCount: number; pageSize: number; filter: ContactFilter; q: string };

export type ConsentHistoryRow = {
  id: string;
  source: string;
  grantedAt: string;
  evidence: string | null;
  recordedBy: string | null;
  unsubscribedAt: string | null;
  unsubscribeSource: string | null;
  open: boolean;
};

export type ContactDetail = {
  id: string;
  email: string;
  name: string | null;
  source: string;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
  customer: { id: string; name: string; email: string } | null;
  consentStatus: ConsentStatus;
  eligibility: EligibilityView;
  consents: ConsentHistoryRow[];
  suppression: { reason: string; note: string | null; createdAt: string; active: boolean; liftedAt: string | null } | null;
};

export type CreateContactOutcome = "recorded" | "already_on_file" | "not_requested" | "blocked_suppressed" | "blocked_inactive" | "failed";

export type CsvRowPreview = { row: number; status: "valid" | "invalid" | "duplicate"; email: string; name: string | null; consent: "explicit" | "none"; outcome: string; issues: string[] };
export type CsvCounts = { totalRows: number; validRows: number; invalidRows: number; duplicateRows: number };
export type CsvPreview = CsvCounts & {
  newContacts: number;
  existingContacts: number;
  /** Valid rows that carry an explicit consent statement with adequate evidence. */
  consentRequested: number;
  /** Of those, rows whose consent would be refused (suppressed address or inactive contact). */
  consentBlocked: number;
  rows: CsvRowPreview[];
  issues: { row: number; message: string }[];
  issuesTruncated: boolean;
};
export type CsvImportSummary = CsvCounts & {
  newContacts: number;
  existingContacts: number;
  existingUpdated: number;
  consentRecorded: number;
  consentAlreadyOnFile: number;
  consentBlocked: number;
  failed: number;
  notProcessed: number;
  /** consentBlocked + failed + notProcessed. */
  skippedOrBlocked: number;
  issues: { row: number; message: string }[];
  issuesTruncated: boolean;
};

// ------------------------------------------------------------------------------------------------------------------------ formula guard
/**
 * Spreadsheet programs run a cell that starts with = + - @ (or a tab / carriage return) as a formula. Any value that came from a CSV file (or any
 * free text an admin or customer typed) is passed through this before it is shown or exported, so a hostile cell is displayed as inert text.
 * The stored value is never altered; only its presentation is. Non-strings give "".
 */
export function csvSafe(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
