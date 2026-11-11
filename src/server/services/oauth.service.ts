import "server-only";
import { prisma } from "@/lib/db/prisma";
import { decideLinking, type OAuthProviderName, type RefuseReason } from "@/lib/oauth/linking";
import type { OAuthProfile } from "@/lib/oauth/providers";
import { logServerError } from "@/lib/logger";

export type SessionUser = { id: string; role: "ADMIN" | "CUSTOMER"; email: string; name: string };

export type OAuthOutcome =
  | { status: "ok"; user: SessionUser }
  | { status: "needs_password"; email: string }
  | { status: "refused"; reason: RefuseReason };

const toSessionUser = (u: { id: string; role: "ADMIN" | "CUSTOMER"; email: string; name: string }): SessionUser => ({
  id: u.id,
  role: u.role,
  email: u.email,
  name: u.name,
});

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/**
 * Applies the linking policy (lib/oauth/linking.ts) to a verified provider profile. Provider
 * tokens are never stored. Two first-time logins racing each other are resolved by the unique
 * indexes: the loser re-reads and signs in to the account the winner just created.
 */
export async function completeOAuthLogin(provider: OAuthProviderName, profile: OAuthProfile, attempt = 0): Promise<OAuthOutcome> {
  const email = profile.email;
  const linkedAccount = await prisma.oAuthAccount.findFirst({
    where: { provider, providerAccountId: profile.providerAccountId },
    include: { user: true },
  });
  const emailUser = email && !linkedAccount ? await prisma.user.findUnique({ where: { email } }) : null;

  const decision = decideLinking({
    linkedUser: linkedAccount ? { id: linkedAccount.user.id, role: linkedAccount.user.role, isActive: linkedAccount.user.isActive } : null,
    emailUser: emailUser ? { id: emailUser.id, role: emailUser.role, isActive: emailUser.isActive, hasPassword: emailUser.passwordHash !== null } : null,
    profile: { email, emailVerified: profile.emailVerified },
  });

  try {
    switch (decision.type) {
      case "refuse":
        return { status: "refused", reason: decision.reason };
      case "needs_password":
        return { status: "needs_password", email: email! };
      case "login": {
        await prisma.oAuthAccount.updateMany({ where: { id: linkedAccount!.id }, data: { lastLoginAt: new Date() } });
        return { status: "ok", user: toSessionUser(linkedAccount!.user) };
      }
            case "link_login": {
        // One account per provider per user: a different identity from the same provider
        // is refused cleanly instead of failing on the unique index.
        if (await prisma.oAuthAccount.findFirst({ where: { userId: decision.userId, provider } })) {
          return { status: "refused", reason: "use_other_method" };
        }
        await prisma.oAuthAccount.create({
          data: { userId: decision.userId, provider, providerAccountId: profile.providerAccountId, emailAtLink: email, emailVerifiedByProvider: profile.emailVerified, lastLoginAt: new Date() },
        });
        return { status: "ok", user: toSessionUser(emailUser!) };
      }
      case "create": {
        const fallbackName = email!.split("@")[0] || "Customer";
        const user = await prisma.$transaction(async (tx) => {
          const created = await tx.user.create({
            data: {
              name: (profile.name?.trim() || fallbackName).slice(0, 100),
              email: email!,
              passwordHash: null, // social-only: no password to guess
              role: "CUSTOMER",
              emailVerified: profile.emailVerified ? new Date() : null,
            },
          });
          await tx.oAuthAccount.create({
            data: { userId: created.id, provider, providerAccountId: profile.providerAccountId, emailAtLink: email, emailVerifiedByProvider: profile.emailVerified, lastLoginAt: new Date() },
          });
          return created;
        });
        return { status: "ok", user: toSessionUser(user) };
      }
    }
  } catch (error) {
    if (isUniqueViolation(error) && attempt === 0) return completeOAuthLogin(provider, profile, 1);
    logServerError("oauth.complete", error, { provider });
    throw error;
  }
}

/**
 * Attaches a social identity to an existing account AFTER the user proved they own it with
 * their password. The pending identity must have been issued for this exact email.
 */
export async function linkAfterPasswordLogin(
  user: { id: string; email: string; role: string },
  pending: { provider: OAuthProviderName; providerAccountId: string; email: string },
): Promise<boolean> {
  if (user.role !== "CUSTOMER" || user.email.toLowerCase() !== pending.email.toLowerCase()) return false;
  try {
    await prisma.oAuthAccount.create({
      data: { userId: user.id, provider: pending.provider, providerAccountId: pending.providerAccountId, emailAtLink: pending.email, emailVerifiedByProvider: false, lastLoginAt: new Date() },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false; // already linked to someone: never steal it
    throw error;
  }
}

export type LinkResult = { status: "linked" } | { status: "refused"; reason: "already_linked" | "taken" | "not_allowed" };

/**
 * Connects a verified provider identity to the CURRENTLY SIGNED-IN customer (the caller has
 * already checked that the session user is the one who started the flow). Rules:
 *   - only active CUSTOMER accounts (never admins);
 *   - one identity per provider per user;
 *   - an identity already linked to ANY user is never moved or shared (collision = refused);
 *   - the provider's email is NOT compared and NEVER changes the account's email, password
 *     or verification state: the signed-in session plus the provider consent are the proof.
 * Linking only ADDS a sign-in method, so it cannot weaken recovery.
 */
export async function linkProviderToUser(userId: string, provider: OAuthProviderName, profile: OAuthProfile): Promise<LinkResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isActive: true } });
  if (!user || user.role !== "CUSTOMER" || !user.isActive) return { status: "refused", reason: "not_allowed" };
  if (await prisma.oAuthAccount.findFirst({ where: { userId, provider }, select: { id: true } })) return { status: "refused", reason: "already_linked" };
  if (await prisma.oAuthAccount.findFirst({ where: { provider, providerAccountId: profile.providerAccountId }, select: { id: true } })) return { status: "refused", reason: "taken" };
  try {
    await prisma.oAuthAccount.create({
      data: { userId, provider, providerAccountId: profile.providerAccountId, emailAtLink: profile.email, emailVerifiedByProvider: profile.emailVerified, lastLoginAt: new Date() },
    });
    return { status: "linked" };
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "refused", reason: "taken" }; // lost a race: never steal it
    throw error;
  }
}
