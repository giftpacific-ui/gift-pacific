"use server";

import { requireAdmin } from "@/lib/auth/current-user";
import { adminCheckSmtpConnection, adminSendSmtpTestEmail, type SmtpActionResult } from "@/server/services/admin-smtp.service";

/**
 * Admin-only SMTP tools (P7.3.2). requireAdmin() runs FIRST (an anonymous caller or a customer gets FORBIDDEN, like every admin action) and the
 * service re-checks the admin in the database. Results carry a fixed message only: never the password, the login, or the server's raw reply.
 */
export async function checkSmtpConnectionAction(): Promise<SmtpActionResult> {
  const admin = await requireAdmin();
  return adminCheckSmtpConnection(admin.id);
}

export async function sendSmtpTestEmailAction(recipient: string): Promise<SmtpActionResult> {
  const admin = await requireAdmin();
  return adminSendSmtpTestEmail(admin.id, recipient);
}
