/**
 * E-mail template rules (Prompt 09). PURE: no database, no network, no secrets. Shared by the template and campaign services so both validate
 * content, placeholders and listing input the same way. The limits mirror the CHECK constraints of migration 20261201000000 (EmailTemplate /
 * EmailCampaign), so the service refuses with a clear message what the database would refuse with a constraint error.
 *
 * Placeholders are NOT a template language. The only syntax is `{{ name }}` with `name` taken from a fixed list: there are no expressions, helpers,
 * conditionals, property access or code, and nothing here evaluates anything. Rendering is a single regex replace pass over the text, so a value
 * that itself contains `{{x}}` is never expanded again. Server-side only like the rest of src/lib/email.
 */

import { checkUnsubscribeUrlShape } from "@/lib/email/list-unsubscribe";

export type FieldError = { field: string; code: string; message: string };

export const TEMPLATE_CATEGORIES = ["MARKETING", "NEWSLETTER", "RECOVERY", "OTHER"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const isTemplateCategory = (v: unknown): v is TemplateCategory => typeof v === "string" && (TEMPLATE_CATEGORIES as readonly string[]).includes(v);

export const TEMPLATE_LIMITS = { name: 120, subject: 200, textBody: 100_000, htmlBody: 200_000 } as const;

/** The ONLY placeholders a template may use. Anything else is refused at save time and again before a campaign uses the template. */
export const SUPPORTED_TEMPLATE_VARIABLES = ["customerName", "firstName", "email", "storeName", "unsubscribeUrl"] as const;
export type TemplateVariable = (typeof SUPPORTED_TEMPLATE_VARIABLES)[number];
const SUPPORTED = new Set<string>(SUPPORTED_TEMPLATE_VARIABLES);

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // a body may hold tab, line feed and carriage return

// ------------------------------------------------------------------------------------------------------------------------------ text fields

const err = (field: string, code: string, message: string): FieldError => ({ field, code, message });

/** One-line text (name, description, sender name): whitespace collapsed, control characters refused (never silently cut). */
export function cleanSingleLine(raw: unknown, field: string, max: number, opts: { required: boolean; label: string }): { ok: true; value: string | null } | { ok: false; error: FieldError } {
  if (raw === undefined || raw === null) return opts.required ? { ok: false, error: err(field, "required", `${opts.label} is required.`) } : { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: err(field, "invalid_type", `${opts.label} must be text.`) };
  if (ANY_CONTROL.test(raw)) return { ok: false, error: err(field, "control_characters", `${opts.label} must not contain line breaks or control characters.`) };
  const value = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!value) return opts.required ? { ok: false, error: err(field, "required", `${opts.label} is required.`) } : { ok: true, value: null };
  if (value.length > max) return { ok: false, error: err(field, "too_long", `${opts.label} must be at most ${max} characters.`) };
  return { ok: true, value };
}

/** A subject line is a header: any line break or control character would allow header injection, so it is refused rather than cleaned. */
export const cleanSubject = (raw: unknown, field = "subject") => cleanSingleLine(raw, field, TEMPLATE_LIMITS.subject, { required: true, label: "Subject" });

// ---------------------------------------------------------------------------------------------------------------------------- placeholders

export type PlaceholderScan = { variables: string[]; problems: { code: "unsupported_variable" | "malformed_placeholder"; detail: string }[] };

/** Finds every placeholder in `text`. Unsupported names and any stray or malformed `{{ }}` (including `{{{ }}}`) are reported as problems. */
export function scanPlaceholders(text: string): PlaceholderScan {
  const found = new Set<string>();
  const unsupported = new Set<string>();
  const problems: PlaceholderScan["problems"] = [];
  if (text.includes("{{{") || text.includes("}}}")) problems.push({ code: "malformed_placeholder", detail: "Triple braces are not allowed; use {{ name }}." });
  const rest = text.replace(PLACEHOLDER, (_m, name: string) => {
    if (SUPPORTED.has(name)) found.add(name);
    else unsupported.add(name);
    return "";
  });
  if (rest.includes("{{") || rest.includes("}}")) problems.push({ code: "malformed_placeholder", detail: "A placeholder must look like {{ name }} with a supported name only." });
  for (const name of unsupported) problems.push({ code: "unsupported_variable", detail: name });
  return { variables: [...found].sort(), problems };
}

// ------------------------------------------------------------------------------------------------------------------------------- html guard

const decodeNumericEntities = (s: string) =>
  s.replace(/&#x([0-9a-f]{1,6});?/gi, (_m, h: string) => safeChar(parseInt(h, 16))).replace(/&#(\d{1,7});?/g, (_m, d: string) => safeChar(parseInt(d, 10)));
const safeChar = (cp: number) => (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "");

/**
 * Defence in depth, NOT a sanitizer: refuses markup that can run code or load active content in a mail client: script/iframe/object/embed/applet/
 * base elements, inline event handlers (onclick=...), and javascript:/vbscript:/data:text URLs in link-like attributes (also when hidden with
 * whitespace, control characters or numeric entities). Returns a short reason, or null when nothing was found.
 */
export function findUnsafeHtml(html: string): string | null {
  if (/<\s*\/?\s*(script|iframe|object|embed|applet|base)\b/i.test(html)) return "must not contain script, iframe, object, embed, applet or base elements";
  if (/<[a-z][^>]*[\s"'/]on[a-z]{2,}\s*=/i.test(html)) return "must not contain inline event handlers such as onclick";
  // eslint-disable-next-line no-control-regex
  const squashed = decodeNumericEntities(html).replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  if (/(?:href|src|action|formaction|background|poster|xlink:href)=["']?(?:javascript|vbscript|data:text)/.test(squashed)) return "must not contain javascript:, vbscript: or data:text links";
  return null;
}

// -------------------------------------------------------------------------------------------------------------------------- content validation

export type TemplateContent = { subject: string; textBody: string; htmlBody: string | null };

/** Validates subject, text body and optional HTML body together (length, characters, placeholders, unsafe markup). */
export function validateTemplateContent(raw: { subject: unknown; textBody: unknown; htmlBody?: unknown }): { ok: true; value: TemplateContent; variables: string[] } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const subject = cleanSubject(raw.subject);
  if (!subject.ok) errors.push(subject.error);

  let textBody = "";
  if (typeof raw.textBody !== "string") errors.push(err("textBody", raw.textBody == null ? "required" : "invalid_type", raw.textBody == null ? "Text body is required." : "Text body must be text."));
  else if (BODY_CONTROL.test(raw.textBody)) errors.push(err("textBody", "control_characters", "Text body must not contain control characters."));
  else if (!raw.textBody.trim()) errors.push(err("textBody", "required", "Text body is required."));
  else if (raw.textBody.length > TEMPLATE_LIMITS.textBody) errors.push(err("textBody", "too_long", `Text body must be at most ${TEMPLATE_LIMITS.textBody} characters.`));
  else textBody = raw.textBody;

  let htmlBody: string | null = null;
  if (raw.htmlBody !== undefined && raw.htmlBody !== null) {
    if (typeof raw.htmlBody !== "string") errors.push(err("htmlBody", "invalid_type", "HTML body must be text."));
    else if (BODY_CONTROL.test(raw.htmlBody)) errors.push(err("htmlBody", "control_characters", "HTML body must not contain control characters."));
    else if (raw.htmlBody.length > TEMPLATE_LIMITS.htmlBody) errors.push(err("htmlBody", "too_long", `HTML body must be at most ${TEMPLATE_LIMITS.htmlBody} characters.`));
    else if (raw.htmlBody.trim()) {
      const unsafe = findUnsafeHtml(raw.htmlBody);
      if (unsafe) errors.push(err("htmlBody", "unsafe_html", `HTML body ${unsafe}.`));
      else htmlBody = raw.htmlBody;
    }
  }

  const variables = new Set<string>();
  const scan = (field: string, text: string | null) => {
    if (text === null) return;
    const res = scanPlaceholders(text);
    res.variables.forEach((v) => variables.add(v));
    for (const p of res.problems) {
      if (p.code === "unsupported_variable") errors.push(err(field, "unsupported_variable", `Unsupported variable "${p.detail}". Supported: ${SUPPORTED_TEMPLATE_VARIABLES.join(", ")}.`));
      else errors.push(err(field, "malformed_placeholder", p.detail));
    }
  };
  scan("subject", subject.ok ? subject.value : null);
  scan("textBody", textBody || null);
  scan("htmlBody", htmlBody);

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { subject: (subject as { ok: true; value: string | null }).value as string, textBody, htmlBody }, variables: [...variables].sort() };
}

// ---------------------------------------------------------------------------------------------------------------------------------- render

export type TemplateValues = Partial<Record<TemplateVariable, string | null | undefined>>;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// eslint-disable-next-line no-control-regex
const stripControls = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ");

function fill(text: string, values: TemplateValues, mode: "header" | "text" | "html"): string {
  // ONE pass with a replacer function: output is never scanned again, so values cannot smuggle in further placeholders.
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    if (!SUPPORTED.has(name)) return ""; // unreachable after validation; never echoes an unknown name
    const raw = values[name as TemplateVariable];
    // Prompt 11: {{unsubscribeUrl}} is the one placeholder that becomes a LINK, so it is never filled with anything but a well-formed unsubscribe-style URL
    // (https, or http to localhost; no credentials, query, fragment, spaces or markup characters). This is a shape check only, so this module stays pure:
    // the strict rule (production = https, our own host, our own path) is enforced where the URL is created (validateUnsubscribeUrl). Anything else renders
    // as empty text, which the campaign message builder then refuses. The URL is still HTML-escaped below like every other value.
    if (name === "unsubscribeUrl" && !(typeof raw === "string" && checkUnsubscribeUrlShape(raw, "development").ok)) return "";
    const value = typeof raw === "string" ? stripControls(raw) : "";
    return mode === "html" ? escapeHtml(value) : value;
  });
}

/**
 * Fills a validated template for ONE recipient. Placeholders without a supplied value become empty text. Values are plain strings only: control
 * characters are removed (no header injection through a customer name) and HTML-escaped inside the HTML body. Refuses content that does not validate.
 */
export function renderEmailTemplate(content: { subject: unknown; textBody: unknown; htmlBody?: unknown }, values: TemplateValues): { ok: true; subject: string; textBody: string; htmlBody: string | null } | { ok: false; errors: FieldError[] } {
  const checked = validateTemplateContent(content);
  if (!checked.ok) return checked;
  const { subject, textBody, htmlBody } = checked.value;
  return { ok: true, subject: fill(subject, values, "header").trim(), textBody: fill(textBody, values, "text"), htmlBody: htmlBody === null ? null : fill(htmlBody, values, "html") };
}

// --------------------------------------------------------------------------------------------------------------------------------- listing

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE = 100_000;

/** page is 1-based. undefined = default; anything that is not a whole number in range is refused (never silently clamped). */
export function normalizePagination(raw: { page?: unknown; pageSize?: unknown }): { ok: true; page: number; pageSize: number; skip: number } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const whole = (v: unknown, field: string, def: number, max: number) => {
    if (v === undefined) return def;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) { errors.push(err(field, "out_of_range", `${field} must be a whole number between 1 and ${max}.`)); return def; }
    return v;
  };
  const page = whole(raw.page, "page", 1, MAX_PAGE);
  const pageSize = whole(raw.pageSize, "pageSize", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return errors.length ? { ok: false, errors } : { ok: true, page, pageSize, skip: (page - 1) * pageSize };
}

/** Search text for a `contains` filter: one line, at most 100 characters; blank = no filter. */
export function cleanSearch(raw: unknown): { ok: true; value: string | null } | { ok: false; errors: FieldError[] } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const res = cleanSingleLine(raw, "search", 100, { required: false, label: "Search text" });
  return res.ok ? res : { ok: false, errors: [res.error] };
}

export const isRecordId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
