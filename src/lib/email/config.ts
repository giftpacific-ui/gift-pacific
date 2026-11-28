/**
 * SMTP configuration (P7.3.1). Pure: reads only the environment object it is given, never throws, never prints a value.
 * Server-side only by construction: none of these variables is NEXT_PUBLIC_*, and nothing under src/features, src/components or any "use client" file may import
 * src/lib/email (a test enforces it). Defaults target Gmail SMTP with STARTTLS (smtp.gmail.com:587) and an App Password.
 */
type Env = Record<string, string | undefined>;

export type SmtpConfig = {
  host: string;
  port: number;
  /** true = implicit TLS (port 465). false = plain connect then a REQUIRED STARTTLS upgrade (port 587). Mail is never sent unencrypted. */
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
};

export type SmtpConfigState =
  | { status: "not_configured" } // SMTP_USER and SMTP_PASS both empty: e-mail is simply off
  | { status: "invalid"; problems: string[] } // some of it set but unusable; messages name the VARIABLE, never its value
  | { status: "ready"; config: SmtpConfig; warnings: string[] };

const EMAIL = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const SMTP_DEFAULTS = { host: "smtp.gmail.com", port: 587, secure: false, fromName: "GiftPacific" } as const;

export function parseSmtpConfig(env: Env = process.env): SmtpConfigState {
  const get = (k: string) => (env[k] ?? "").trim();
  const user = get("SMTP_USER");
  // Google shows App Passwords as "abcd efgh ijkl mnop"; spaces are not part of the password.
  const passRaw = env.SMTP_PASS ?? "";
  if (!user && !passRaw.trim()) return { status: "not_configured" };

  const problems: string[] = [];
  const warnings: string[] = [];

  const host = get("SMTP_HOST") || SMTP_DEFAULTS.host;
  if (!HOSTNAME.test(host)) problems.push("SMTP_HOST must be a host name such as smtp.gmail.com (no scheme, port or path).");

  const portRaw = get("SMTP_PORT");
  const port = portRaw === "" ? SMTP_DEFAULTS.port : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("SMTP_PORT must be a whole number between 1 and 65535 (587 for STARTTLS, 465 for SSL).");

  const secureRaw = get("SMTP_SECURE").toLowerCase();
  if (secureRaw !== "" && secureRaw !== "true" && secureRaw !== "false") problems.push('SMTP_SECURE must be "true" or "false".');
  const secure = secureRaw === "" ? (port === 465 ? true : SMTP_DEFAULTS.secure) : secureRaw === "true";
  if (Number.isInteger(port)) {
    if (port === 465 && !secure) problems.push("SMTP_PORT=465 needs SMTP_SECURE=true (SSL).");
    if (port === 587 && secure) problems.push("SMTP_PORT=587 needs SMTP_SECURE=false (STARTTLS).");
  }

  if (!user) problems.push("SMTP_USER is required (the full Gmail address).");
  else if (!EMAIL.test(user) || CONTROL.test(user)) problems.push("SMTP_USER must be a valid e-mail address.");

  const isGmail = /(^|\.)gmail\.com$/i.test(host) || /(^|\.)googlemail\.com$/i.test(host);
  const pass = isGmail ? passRaw.replace(/\s+/g, "") : passRaw.trim();
  if (!pass) problems.push("SMTP_PASS is required (for Gmail: a 16-character App Password, not your Google password).");
  else if (CONTROL.test(pass)) problems.push("SMTP_PASS contains a control character (check for a stray line break).");
  else if (isGmail && !/^[a-z]{16}$/i.test(pass)) warnings.push("SMTP_PASS does not look like a 16-letter Gmail App Password. Normal Google passwords are rejected by Gmail SMTP; create an App Password (2-Step Verification must be on).");

  const fromName = get("SMTP_FROM_NAME") || SMTP_DEFAULTS.fromName;
  if (CONTROL.test(fromName) || fromName.length > 100) problems.push("SMTP_FROM_NAME must be a single line of at most 100 characters.");
  const fromEmail = get("SMTP_FROM_EMAIL") || user;
  if (!EMAIL.test(fromEmail) || CONTROL.test(fromEmail)) problems.push("SMTP_FROM_EMAIL must be a valid e-mail address (leave it empty to use SMTP_USER).");
  else if (isGmail && user && fromEmail.toLowerCase() !== user.toLowerCase()) warnings.push("SMTP_FROM_EMAIL differs from SMTP_USER: Gmail replaces the sender with SMTP_USER unless the address is added under Gmail → Settings → Accounts → Send mail as.");

  if (problems.length > 0) return { status: "invalid", problems };
  return { status: "ready", config: { host, port, secure, user, pass, fromName, fromEmail }, warnings };
}

/** Safe summary for logs/admin screens/scripts: says what is set, never a secret. The user is masked (a***@gmail.com). */
export function describeSmtpConfig(state: SmtpConfigState): Record<string, unknown> {
  if (state.status === "not_configured") return { status: "not_configured" };
  if (state.status === "invalid") return { status: "invalid", problems: state.problems };
  const { host, port, secure, user, fromName, fromEmail } = state.config;
  const mask = maskEmail;
  return { status: "ready", host, port, secure, user: mask(user), from: `${fromName} <${mask(fromEmail)}>`, passwordSet: true, warnings: state.warnings };
}

export type RecipientCheck = { ok: true; email: string } | { ok: false; message: string };

/** Validates ONE recipient address typed by an admin (P7.3.2). No lists, no display names, no control characters (header injection). */
export function validateRecipientEmail(raw: unknown): RecipientCheck {
  if (typeof raw !== "string") return { ok: false, message: "Enter the e-mail address to send the test to." };
  const email = raw.trim();
  if (!email) return { ok: false, message: "Enter the e-mail address to send the test to." };
  if (email.length > 254 || CONTROL.test(email) || !EMAIL.test(email)) return { ok: false, message: "Enter one valid e-mail address (for example you@example.com)." };
  return { ok: true, email };
}

/** a***@gmail.com: for logs and audit records, which must not hold a full address. */
export function maskEmail(email: string): string {
  return email.replace(/^(.).*(@.*)$/, "$1***$2");
}
