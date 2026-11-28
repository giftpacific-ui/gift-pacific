/**
 * E-mail queue policy (P7.3.3). PURE: no database, no network, no secrets. Everything that decides "how many / how long / retry or not / is this input
 * acceptable" lives here so it can be tested without a database. The queue itself is src/server/services/email-queue.service.ts.
 */
import { createHash } from "node:crypto";
import { validateRecipientEmail } from "@/lib/email/config";
import type { SmtpFailureCode } from "@/lib/email/smtp";

type Env = Record<string, string | undefined>;

/** Attempts made (including the first) before a temporary failure becomes FAILED. */
export const EMAIL_JOB_MAX_ATTEMPTS = 5;
/** Wait after failed attempt 1, 2, 3, 4. After attempt 5 the job is FAILED. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000] as const;
/** A PROCESSING claim older than this is assumed abandoned (crashed worker). One send is bounded by ~35 s of SMTP timeouts, so 5 minutes is generous. */
export const EMAIL_PROCESSING_STALE_MS = 5 * 60_000;
/** After a SYSTEM-WIDE failure (bad login, TLS, not configured) a job waits this long, and the run stops: the next job would fail the same way. */
export const EMAIL_SYSTEMIC_PAUSE_MS = 30 * 60_000;
/** After an unexpected internal error (database hiccup, bug) the claim is released for this long. */
export const EMAIL_INTERNAL_RETRY_MS = 5 * 60_000;
/** A job still PENDING after this long is FAILED "expired": a marketing mail sent a week late is worse than not sent. */
export const EMAIL_JOB_MAX_AGE_MS = 7 * 86_400_000;
/** Retention: SENT rows (body already removed) and FAILED rows are deleted after this long. */
export const EMAIL_SENT_RETENTION_MS = 30 * 86_400_000;
export const EMAIL_FAILED_RETENTION_MS = 60 * 86_400_000;
/** Most jobs one enqueueEmails() call accepts, and the chunk size of its inserts. */
export const EMAIL_MAX_BULK_ENQUEUE = 5_000;
export const EMAIL_ENQUEUE_CHUNK = 500;
/** One run of the PROTECTED /api/email/queue route stops starting new sends after this long (the route allows 60 s). Admin-triggered runs use manualSendDeadlineMs. */
export const EMAIL_RUN_DEADLINE_MS = 45_000;

/**
 * ADMIN-TRIGGERED RUNS ONLY (Send now, Continue sending, abandoned-cart sending, manual Retry). Nothing in this project calls the queue on a timer: these
 * limits exist so that ONE admin request always finishes inside the Vercel Hobby function limit that every page hosting such an action declares
 * (`export const maxDuration = 60`; 60 s is valid on Hobby with or without Fluid Compute). Whatever does not fit stays PENDING for the next click.
 *
 *   request budget 55 s (5 s left for the response) = work already done by the request + the send loop + one last in-flight send.
 *   The send loop stops STARTING sends when the remaining budget minus EMAIL_SMTP_WORST_CASE_MS is used up, because a send that starts right at the
 *   deadline can still take connection 10 s + greeting 10 s + socket 15 s (SMTP_TIMEOUTS in lib/email/smtp.ts; tests keep these two numbers in step).
 */
export const EMAIL_REQUEST_BUDGET_MS = 55_000;
export const EMAIL_SMTP_WORST_CASE_MS = 35_000;
/** Most e-mails ONE admin request may start (on top of the env batch size and the hourly/daily limits, which still apply). */
export const EMAIL_MANUAL_MAX_JOBS = 20;
/** Most jobs an admin may select for one Retry click (more are refused, never silently dropped). */
export const EMAIL_MANUAL_MAX_SELECTION = 50;
/** Most carts an admin may ask to remind in one click. */
export const EMAIL_MANUAL_MAX_CARTS = 25;
/** Campaign dispatch (queueing recipients) stops starting new chunks after this long in an admin request; the rest stays PENDING and is resumed by "Continue sending". */
export const EMAIL_MANUAL_DISPATCH_DEADLINE_MS = 8_000;

/** How long the send loop of an admin request may keep STARTING sends, given how long the request has already been running. 0 = no time left: send nothing. */
export function manualSendDeadlineMs(elapsedMs: number): number {
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  return Math.max(0, EMAIL_REQUEST_BUDGET_MS - EMAIL_SMTP_WORST_CASE_MS - elapsed);
}

export const EMAIL_PRIORITY = { transactional: 0, bulk: 1 } as const;
export type EmailPriority = keyof typeof EMAIL_PRIORITY;

/** Delay before the next attempt after `attempts` attempts have been made (1-based). null = give up. */
export function nextEmailRetryDelayMs(attempts: number): number | null {
  if (!Number.isInteger(attempts) || attempts < 1) return BACKOFF_MS[0];
  if (attempts >= EMAIL_JOB_MAX_ATTEMPTS) return null;
  return BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
}

export type FailureClass = "permanent" | "temporary" | "systemic";

/**
 * How a failed send is handled.
 *  permanent: this recipient/message will never work (address refused) -> FAILED now.
 *  temporary: network trouble, timeouts, a refusal that may be a rate/quota limit -> retry with backoff, bounded by EMAIL_JOB_MAX_ATTEMPTS.
 *  systemic:  the SMTP setup itself is broken (login, TLS, missing settings). Every job would fail the same way, so the job is put back WITHOUT
 *             using up an attempt, waits EMAIL_SYSTEMIC_PAUSE_MS, and the run stops (no hammering of the mail server / no locked Gmail account).
 */
export function classifyEmailFailure(code: SmtpFailureCode): FailureClass {
  switch (code) {
    case "recipient_rejected":
      return "permanent";
    case "not_configured":
    case "invalid_config":
    case "auth_failed":
    case "tls_failed":
    case "dependency_missing":
      return "systemic";
    default:
      return "temporary"; // timeout, connection_failed, dns_failed, send_rejected, unknown
  }
}

// ------------------------------------------------------------------------------------------------------------------------------ rate limits

export type EmailQueueLimits = { batchSize: number; perHour: number; perDay: number };
export const EMAIL_QUEUE_DEFAULTS: EmailQueueLimits = { batchSize: 20, perHour: 100, perDay: 400 };
const BOUNDS = { batchSize: [1, 100], perHour: [1, 1_000], perDay: [1, 5_000] } as const;

/**
 * Sending limits from the environment. Defaults stay well under Gmail's published SMTP limits (about 500 recipients/day for a free account),
 * so the queue is the thing that slows down, not the mail provider that blocks the account. Unusable values fall back to the default.
 */
export function parseEmailQueueLimits(env: Env = process.env): EmailQueueLimits {
  const read = (name: string, key: keyof EmailQueueLimits): number => {
    const raw = (env[name] ?? "").trim();
    if (!/^\d{1,6}$/.test(raw)) return EMAIL_QUEUE_DEFAULTS[key];
    const [min, max] = BOUNDS[key];
    const n = Number(raw);
    return n >= min && n <= max ? n : EMAIL_QUEUE_DEFAULTS[key];
  };
  return { batchSize: read("EMAIL_QUEUE_BATCH_SIZE", "batchSize"), perHour: read("EMAIL_QUEUE_MAX_PER_HOUR", "perHour"), perDay: read("EMAIL_QUEUE_MAX_PER_DAY", "perDay") };
}

/** How many e-mails this run may start: the batch size, capped by what is left of the hourly and daily budget. Never negative. */
export function emailSendBudget(limits: EmailQueueLimits, sentLastHour: number, sentLastDay: number): number {
  return Math.max(0, Math.min(limits.batchSize, limits.perHour - sentLastHour, limits.perDay - sentLastDay));
}

// -------------------------------------------------------------------------------------------------------------------------------- de-duplication

const KIND = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/**
 * The de-duplication key. `kind` + `parts` identify ONE logical e-mail, for example ("order-confirmation", [orderNumber]) or
 * ("campaign", [campaignId, recipientAddress]). Parts are trimmed and lower-cased (so `A@x.com` and `a@x.com` are the same recipient), hashed
 * together with the kind (so no address appears in the key) and joined unambiguously. Returns null for an unusable kind/parts.
 */
export function emailDedupeKey(kind: string, parts: readonly string[]): string | null {
  if (!KIND.test(kind) || !Array.isArray(parts) || parts.length === 0 || parts.length > 8) return null;
  const clean: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") return null;
    const v = part.normalize("NFKC").trim().toLowerCase();
    if (!v || v.length > 300) return null;
    clean.push(v);
  }
  return `${kind}:${createHash("sha256").update(JSON.stringify([kind, ...clean])).digest("hex").slice(0, 40)}`;
}

// ------------------------------------------------------------------------------------------------------------------------------------ input

export type EmailJobInput = { kind: string; dedupeParts: readonly string[]; to: string; subject: string; text: string; html?: string | null };
export type ValidEmailJob = { kind: string; dedupeKey: string; toEmail: string; subject: string; text: string; html: string | null };
export type EmailJobCheck = { ok: true; job: ValidEmailJob } | { ok: false; message: string };

export const EMAIL_LIMITS = { subject: 200, text: 100_000, html: 200_000 } as const;
const SINGLE_LINE = /^[^\u0000-\u001f\u007f]+$/;

/** Validates one job before it is stored: one valid recipient, a single-line subject, bounded bodies, a usable de-duplication key. Messages are fixed text. */
export function validateEmailJobInput(input: EmailJobInput): EmailJobCheck {
  const to = validateRecipientEmail(input?.to);
  if (!to.ok) return { ok: false, message: to.message };
  const key = emailDedupeKey(input.kind, input.dedupeParts);
  if (!key) return { ok: false, message: "The e-mail needs a kind (a short lower-case label) and at least one identifying part to prevent duplicates." };
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject || subject.length > EMAIL_LIMITS.subject || !SINGLE_LINE.test(subject)) return { ok: false, message: "The e-mail subject must be a single line of 1 to 200 characters." };
  if (typeof input.text !== "string" || input.text.trim() === "" || input.text.length > EMAIL_LIMITS.text) return { ok: false, message: "The e-mail text is required and must be at most 100,000 characters." };
  const html = input.html ?? null;
  if (html !== null && (typeof html !== "string" || html.length > EMAIL_LIMITS.html)) return { ok: false, message: "The e-mail HTML must be at most 200,000 characters." };
  return { ok: true, job: { kind: input.kind, dedupeKey: key, toEmail: to.email, subject, text: input.text, html: html === "" ? null : html } };
}
