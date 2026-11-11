/**
 * OPERATOR SCRIPT — sets a new password for an existing account.
 *
 * Why this exists: V1 has no email provider, so a customer (or admin) who has
 * forgotten their password cannot receive a reset link. The storefront tells
 * them to contact the store; this script is what the person running the store
 * uses to help them, after verifying who they are.
 *
 *   NEW_PASSWORD='a-strong-Password-1' pnpm user:set-password customer@example.com
 *
 * The password is read from the NEW_PASSWORD environment variable (not an
 * argument) so it doesn't end up in shell history or `ps` output. Share the
 * temporary password with the customer over a channel you trust and ask them
 * to change it from Account → Settings.
 *
 * Effects: replaces the password hash and deletes any outstanding reset
 * tokens. It does not touch orders, addresses or anything else. Existing
 * login cookies are stateless JWTs and expire on their own schedule.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { validateNewPassword } from "./password-rules";

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  const check = validateNewPassword(process.env.NEW_PASSWORD, email);
  if (!email || !check.ok) {
    console.error(`❌ ${check.ok ? "Usage: NEW_PASSWORD='…' pnpm user:set-password <email>" : check.message}`);
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
    if (!user) {
      console.error("❌ No account with that email address. Nothing was changed.");
      process.exitCode = 1;
      return;
    }
    const passwordHash = await bcrypt.hash(check.password, 12);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    ]);
    console.log(`✅ Password updated for ${email} (${user.role.toLowerCase()}). Outstanding reset tokens were removed.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("❌ Failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
