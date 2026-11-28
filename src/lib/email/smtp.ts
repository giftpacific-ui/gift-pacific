/**
 * Central SMTP client (P7.3.1): the ONE place that creates a Nodemailer transport. Later features (P7.3.2+) must send through this module.
 * Server-side only (see config.ts). Deliberately free of `server-only` so `scripts/verify-smtp.ts` can run it from the command line.
 * P7.3.1 added connection verification; P7.3.2 adds `sendSmtpMail`, the single send function (used by the admin "Send test email" action).
 */
import { logServerWarning } from "@/lib/logger";
import { parseSmtpConfig, validateRecipientEmail, type SmtpConfig } from "@/lib/email/config";
import { isValidListUnsubscribeHeaders, type ListUnsubscribeHeaders } from "@/lib/email/list-unsubscribe";

export type SmtpSentInfo = { messageId?: unknown; accepted?: unknown; rejected?: unknown };
export type SmtpMailPayload = { from: { name: string; address: string }; to: string; subject: string; text: string; html?: string; headers?: ListUnsubscribeHeaders };
export type SmtpTransportLike = { verify(): Promise<unknown>; close(): void; sendMail?(mail: SmtpMailPayload): Promise<SmtpSentInfo> };
export type TransportFactory = (options: Record<string, unknown>) => SmtpTransportLike;

export const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 } as const;

/** Nodemailer options for a validated config. TLS is mandatory (STARTTLS is REQUIRED on 587: no silent downgrade to plain text). */
export function buildTransportOptions(c: SmtpConfig): Record<string, unknown> {
  return {
    host: c.host, port: c.port, secure: c.secure, requireTLS: !c.secure,
    auth: { user: c.user, pass: c.pass },
    ...SMTP_TIMEOUTS,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    // Never log SMTP conversations (they contain the base64 credentials).
    logger: false, debug: false,
  };
}

/** The sender header value, built from validated parts only. */
export function fromAddress(c: SmtpConfig): { name: string; address: string } {
  return { name: c.fromName, address: c.fromEmail };
}

async function defaultFactory(): Promise<TransportFactory> {
  const nodemailer = await import("nodemailer");
  return (o) => nodemailer.createTransport(o as never) as unknown as SmtpTransportLike;
}

/** Returns a transport for the current environment, or null when e-mail is not configured / invalid. Callers never see the credentials. */
export async function createSmtpTransport(env: Record<string, string | undefined> = process.env, factory?: TransportFactory) {
  const state = parseSmtpConfig(env);
  if (state.status !== "ready") return null;
  const make = factory ?? (await defaultFactory());
  return { transport: make(buildTransportOptions(state.config)), config: state.config };
}

export type SmtpFailureCode = "not_configured" | "invalid_config" | "auth_failed" | "tls_failed" | "dns_failed" | "dependency_missing" | "timeout" | "connection_failed" | "recipient_rejected" | "send_rejected" | "unknown";
type RuntimeFailureCode = Exclude<SmtpFailureCode, "invalid_config" | "not_configured">;
export type SmtpVerifyResult =
  | { ok: true; host: string; port: number }
  | { ok: false; code: SmtpFailureCode; message: string; problems?: string[] };

const MESSAGES: Record<RuntimeFailureCode, string> = {
  recipient_rejected: "The SMTP server refused the recipient address. Check that it is spelled correctly and can receive mail.",
  send_rejected: "The SMTP server accepted the login but refused to send the message. For Gmail this usually means the daily sending limit was reached or the sender address is not allowed.",
  auth_failed: "The SMTP server rejected the login. For Gmail use the full address and a 16-character App Password (2-Step Verification required).",
  tls_failed: "The secure (TLS) connection could not be established. Check SMTP_PORT and SMTP_SECURE (587 + false, or 465 + true).",
  dns_failed: "The SMTP host name could not be found. Check SMTP_HOST.",
  dependency_missing: "The nodemailer package is not installed. Run `pnpm install`.",
  timeout: "The SMTP server did not answer in time. Check SMTP_HOST/SMTP_PORT and that the network allows outbound SMTP.",
  connection_failed: "Could not connect to the SMTP server. Check SMTP_HOST/SMTP_PORT and outbound network access.",
  unknown: "The SMTP check failed for an unexpected reason. See the server log (it contains no credentials).",
};

/** Maps a Nodemailer/Node error to a fixed code. The raw error text is NEVER returned (server replies can echo the user name). */
export function classifySmtpError(error: unknown): RuntimeFailureCode {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") return "dependency_missing";
  const responseCode = Number((error as { responseCode?: unknown })?.responseCode);
  if (code === "EAUTH" || responseCode === 535 || responseCode === 534 || responseCode === 530) return "auth_failed";
  if (code === "EENVELOPE") return "recipient_rejected";
  if (code === "EMESSAGE" || (Number.isInteger(responseCode) && responseCode >= 400 && code !== "ECONNECTION" && code !== "ESOCKET")) return "send_rejected";
  if (code === "ETIMEDOUT" || code === "ECONNECTION_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
  if (code === "ESOCKET" && /ssl|tls|certificate|wrong version/i.test(String((error as Error)?.message ?? ""))) return "tls_failed";
  if (code === "ETLS" || code === "ERR_TLS_CERT_ALTNAME_INVALID" || /^ERR_SSL|CERT_/.test(code)) return "tls_failed";
  if (code === "EDNS" || code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_failed";
  if (code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ESOCKET" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "connection_failed";
  return "unknown";
}

/**
 * Safe connection check: opens a connection, authenticates, sends NO mail, closes. Bounded by timeouts. The result carries only a fixed code and message,
 * never the credentials, the server's reply text or the exception. Nothing but the code is logged.
 */
export async function verifySmtpConnection(env: Record<string, string | undefined> = process.env, factory?: TransportFactory): Promise<SmtpVerifyResult> {
  const state = parseSmtpConfig(env);
  if (state.status === "not_configured") return { ok: false, code: "not_configured", message: "SMTP is not configured: set SMTP_USER and SMTP_PASS (see .env.example)." };
  if (state.status === "invalid") return { ok: false, code: "invalid_config", message: "SMTP settings are invalid.", problems: state.problems };
  let transport: SmtpTransportLike | null = null;
  try {
    transport = (await createSmtpTransport(env, factory))!.transport;
    await transport.verify();
    return { ok: true, host: state.config.host, port: state.config.port };
  } catch (error) {
    const code = classifySmtpError(error);
    logServerWarning("smtp.verify_failed", `SMTP verification failed (${code})`, { code });
    return { ok: false, code, message: MESSAGES[code] };
  } finally {
    try { transport?.close(); } catch { /* ignore */ }
  }
}

export type SmtpSendResult =
  | { ok: true; host: string; port: number; messageId: string | null }
  | { ok: false; code: SmtpFailureCode; message: string; problems?: string[] };

const SINGLE_LINE = /^[^\u0000-\u001f\u007f]{1,200}$/;

/**
 * THE send function. Builds the transport from the environment, sends ONE message to ONE validated recipient and closes the connection.
 * Success means the SMTP server ACCEPTED the message for that recipient (it says nothing about inbox vs spam). Failures return a fixed code and
 * message; the raw error (which can echo the user name) is never returned, and only the code is logged.
 */
export async function sendSmtpMail(message: { to: string; subject: string; text: string; html?: string; headers?: ListUnsubscribeHeaders }, env: Record<string, string | undefined> = process.env, factory?: TransportFactory): Promise<SmtpSendResult> {
  const state = parseSmtpConfig(env);
  if (state.status === "not_configured") return { ok: false, code: "not_configured", message: "SMTP is not configured: set SMTP_USER and SMTP_PASS on the server (see .env.example)." };
  if (state.status === "invalid") return { ok: false, code: "invalid_config", message: "SMTP settings are invalid.", problems: state.problems };
  const to = validateRecipientEmail(message.to);
  if (!to.ok) return { ok: false, code: "recipient_rejected", message: to.message };
  if (!SINGLE_LINE.test(message.subject)) return { ok: false, code: "send_rejected", message: "The e-mail subject must be a single line." };
  // Prompt 11: the ONLY extra headers a message may carry are the two List-Unsubscribe headers, each re-validated here (https URL only, no line breaks,
  // nothing else). Messages without `headers` (every transactional e-mail) are sent exactly as before.
  if (message.headers !== undefined && !isValidListUnsubscribeHeaders(message.headers, process.env.NODE_ENV)) return { ok: false, code: "send_rejected", message: "The e-mail headers are not valid." };

  let transport: SmtpTransportLike | null = null;
  try {
    transport = (await createSmtpTransport(env, factory))!.transport;
    if (!transport.sendMail) throw Object.assign(new Error("transport cannot send"), { code: "ESEND_UNSUPPORTED" });
    const info = await transport.sendMail({ from: fromAddress(state.config), to: to.email, subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}), ...(message.headers ? { headers: { ...message.headers } } : {}) });
    const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
    if (accepted.length === 0 || rejected.length > 0) {
      logServerWarning("smtp.send_failed", "SMTP server did not accept the recipient (recipient_rejected)", { code: "recipient_rejected" });
      return { ok: false, code: "recipient_rejected", message: MESSAGES.recipient_rejected };
    }
    return { ok: true, host: state.config.host, port: state.config.port, messageId: typeof info.messageId === "string" ? info.messageId : null };
  } catch (error) {
    const code = classifySmtpError(error);
    logServerWarning("smtp.send_failed", `SMTP send failed (${code})`, { code });
    return { ok: false, code, message: MESSAGES[code] };
  } finally {
    try { transport?.close(); } catch { /* ignore */ }
  }
}
