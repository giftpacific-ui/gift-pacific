"use server";

import crypto from "node:crypto";
import { RATE_LIMITS, clientAddress, consumeRateLimit, throttledMessage } from "@/lib/rate-limit";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  type ForgotPasswordInput,
  type ResetPasswordInput,
} from "@/lib/validations/auth";
import type { AuthActionState } from "@/server/actions/auth.actions";

const RESET_TOKEN_TTL_MS = 1000 * 60 * 30; // 30 minutes

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * V1 has NO email provider, so a reset link cannot be delivered to a
 * customer. Therefore:
 *  - in production this issues nothing and the UI says plainly that
 *    automatic emails aren't available (customers contact the store);
 *  - outside production the raw token is returned so the flow can be
 *    exercised end-to-end locally. It is never returned in production.
 * Always reports success regardless of whether the email exists, so it
 * can't be used to discover which emails are registered.
 */
export async function requestPasswordReset(
  input: ForgotPasswordInput,
): Promise<AuthActionState & { devToken?: string }> {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const throttle = await consumeRateLimit(RATE_LIMITS.passwordReset, [await clientAddress()]);
  if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };
  if (process.env.NODE_ENV === "production") {
    return { success: true };
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user) {
    return { success: true };
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  return { success: true, devToken: rawToken };
}

export async function resetPassword(
  input: ResetPasswordInput,
): Promise<AuthActionState> {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const throttle = await consumeRateLimit(RATE_LIMITS.passwordReset, [await clientAddress()]);
  if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };
  const tokenHash = hashToken(parsed.data.token);
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (
    !record ||
    record.usedAt ||
    record.expiresAt.getTime() < Date.now()
  ) {
    return { success: false, message: "This reset link is invalid or has expired." };
  }

  const passwordHash = await hashPassword(parsed.data.password);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  return { success: true };
}
