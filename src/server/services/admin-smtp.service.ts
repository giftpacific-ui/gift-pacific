import "server-only";
import { prisma } from "@/lib/db/prisma";
import { parseSmtpConfig, maskEmail, validateRecipientEmail } from "@/lib/email/config";
import { sendSmtpMail, verifySmtpConnection, type SmtpFailureCode } from "@/lib/email/smtp";
import { logServerInfo } from "@/lib/logger";
import { consumeRateLimit, RATE_LIMITS, throttledMessage } from "@/lib/rate-limit";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";

/**
 * Admin view of the SMTP settings (P7.3.2).
 * SECURITY: every DTO below is built FIELD BY FIELD from the parsed config. The config object itself (which holds the password) is never spread,
 * returned or serialised, so no API, server action or page prop can carry the password. A test asserts this.
 */
export type SmtpAdminStatus = {
  /** not_configured = e-mail is off; invalid = some variables are set but unusable; configured = settings are valid (the connection is NOT checked here). */
  state: "not_configured" | "invalid" | "configured";
  senderName: string | null;
  senderEmail: string | null;
  host: string | null;
  port: number | null;
  encryption: "STARTTLS" | "SSL/TLS" | null;
  /** The SMTP login, masked (a***@gmail.com). */
  loginUser: string | null;
  passwordSet: boolean;
  problems: string[];
  warnings: string[];
};

export type SmtpActionResult =
  | { success: true; message: string; detail?: string }
  | { success: false; message: string; code: SmtpFailureCode | "forbidden" | "throttled" | "invalid_recipient" };

/** Reads the environment only: opens no connection, so loading the settings page is instant and never contacts the mail server. */
export function getSmtpAdminStatus(env: Record<string, string | undefined> = process.env): SmtpAdminStatus {
  const state = parseSmtpConfig(env);
  if (state.status === "not_configured") return { state: "not_configured", senderName: null, senderEmail: null, host: null, port: null, encryption: null, loginUser: null, passwordSet: false, problems: [], warnings: [] };
  if (state.status === "invalid") return { state: "invalid", senderName: null, senderEmail: null, host: null, port: null, encryption: null, loginUser: null, passwordSet: false, problems: state.problems, warnings: [] };
  const c = state.config;
  return { state: "configured", senderName: c.fromName, senderEmail: c.fromEmail, host: c.host, port: c.port, encryption: c.secure ? "SSL/TLS" : "STARTTLS", loginUser: maskEmail(c.user), passwordSet: true, problems: [], warnings: state.warnings };
}

type Env = Record<string, string | undefined>;
type Tx = Parameters<typeof assertAdminActor>[0];

/** Logs in to the SMTP server and sends nothing. The admin is re-checked in the database (defence in depth behind requireAdmin). */
export async function adminCheckSmtpConnection(adminId: string | null | undefined, env: Env = process.env, factory?: Parameters<typeof verifySmtpConnection>[1]): Promise<SmtpActionResult> {
  try { await assertAdminActor(prisma as unknown as Tx, adminId); } catch { return { success: false, code: "forbidden", message: "You are not authorised to do this." }; }
  const limit = await consumeRateLimit(RATE_LIMITS.smtpCheckAdmin, [adminId as string]);
  if (!limit.ok) return { success: false, code: "throttled", message: throttledMessage(limit) };
  const r = await verifySmtpConnection(env, factory);
  if (r.ok) return { success: true, message: `Connected and logged in to ${r.host}:${r.port}. No e-mail was sent.` };
  return { success: false, code: r.code, message: r.problems?.length ? `${r.message} ${r.problems.join(" ")}` : r.message };
}

/** Sends ONE fixed-content test e-mail through the central SMTP service and reports exactly what happened. The body is not admin-controlled. */
export async function adminSendSmtpTestEmail(adminId: string | null | undefined, rawRecipient: unknown, env: Env = process.env, factory?: Parameters<typeof verifySmtpConnection>[1]): Promise<SmtpActionResult> {
  try { await assertAdminActor(prisma as unknown as Tx, adminId); } catch { return { success: false, code: "forbidden", message: "You are not authorised to do this." }; }
  const to = validateRecipientEmail(rawRecipient);
  if (!to.ok) return { success: false, code: "invalid_recipient", message: to.message };
  const limit = await consumeRateLimit(RATE_LIMITS.smtpTestEmailAdmin, [adminId as string]);
  if (!limit.ok) return { success: false, code: "throttled", message: throttledMessage(limit) };

  const sentAt = new Date().toISOString();
  const state = getSmtpAdminStatus(env);
  const name = state.senderName ?? "GiftPacific";
  const result = await sendSmtpMail(
    {
      to: to.email,
      subject: `${name}: SMTP test email`,
      text: `This is a test e-mail from the ${name} admin panel.\n\nIf you can read this, the store's SMTP settings work and the server can send e-mail.\nSent at ${sentAt} (UTC).\n\nNo action is needed. You can delete this message.`,
      html: `<p>This is a test e-mail from the <strong>${name.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)}</strong> admin panel.</p><p>If you can read this, the store's SMTP settings work and the server can send e-mail.</p><p style="color:#666;font-size:12px">Sent at ${sentAt} (UTC). No action is needed; you can delete this message.</p>`,
    },
    env,
    factory,
  );

  // The audit trail records who tested, the masked recipient and the outcome. Never the password, never the raw server reply.
  await recordAudit(prisma as unknown as Parameters<typeof recordAudit>[0], {
    actorId: adminId as string, action: "SMTP_TEST_EMAIL", entityType: "SmtpSettings",
    detail: { recipient: maskEmail(to.email), outcome: result.ok ? "accepted" : result.code },
  }).catch(() => undefined);

  if (result.ok) {
    logServerInfo("smtp.test_sent", "SMTP test e-mail accepted by the server", { host: result.host });
    return { success: true, message: `The SMTP server (${result.host}) accepted the test e-mail for ${to.email}. Check that inbox (and the spam folder).`, detail: "Accepted means the mail server took the message; it does not prove inbox delivery." };
  }
  return { success: false, code: result.code, message: result.problems?.length ? `${result.message} ${result.problems.join(" ")}` : result.message };
}
