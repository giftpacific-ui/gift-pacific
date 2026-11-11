import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { PROVIDERS } from "@/lib/oauth/config";
import type { OAuthProviderName } from "@/lib/oauth/linking";

export type ConnectedAccountsView = {
  hasPassword: boolean;
  accounts: { provider: OAuthProviderName; emailAtLink: string | null; linkedAt: Date; lastLoginAt: Date | null; canUnlink: boolean }[];
};

/** A sign-in method is "usable" only if it can be used right now: a password, or another linked provider. */
export function canRemoveProvider(hasPassword: boolean, linkedCount: number): boolean {
  return hasPassword || linkedCount >= 2;
}

export async function getConnectedAccounts(userId: string): Promise<ConnectedAccountsView> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) throw new UserFacingError("Account not found.");
  const hasPassword = Boolean(user.passwordHash);
  const rows = (await prisma.oAuthAccount.findMany({ where: { userId } })).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    hasPassword,
    accounts: rows.map((a) => ({
      provider: a.provider as OAuthProviderName,
      emailAtLink: a.emailAtLink,
      linkedAt: a.createdAt,
      lastLoginAt: a.lastLoginAt,
      canUnlink: canRemoveProvider(hasPassword, rows.length),
    })),
  };
}

/**
 * Removes one linked provider. The user row is locked first (an UPDATE takes the row lock), so two
 * parallel unlink requests cannot both pass the "still has another way in" check and strand the account.
 * Admins never have social links; refusing here keeps that true.
 */
export async function unlinkProvider(userId: string, provider: string): Promise<void> {
  if (!(PROVIDERS as string[]).includes(provider)) throw new UserFacingError("Unknown provider.");
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: { updatedAt: new Date() }, select: { role: true, passwordHash: true } });
    if (user.role === "ADMIN") throw new UserFacingError("Admin accounts sign in with a password only.");
    const linked = await tx.oAuthAccount.findMany({ where: { userId }, select: { id: true, provider: true } });
    const target = linked.find((a) => a.provider === provider);
    if (!target) throw new UserFacingError("That account is not connected.");
    if (!canRemoveProvider(Boolean(user.passwordHash), linked.length)) {
      throw new UserFacingError("This is your only way to sign in. Set a password first, then you can disconnect it.");
    }
    await tx.oAuthAccount.deleteMany({ where: { id: target.id, userId } });
  });
}

/** Lets a social-only customer (signed in) add a password. Existing passwords are changed through the normal form. */
export async function setInitialPassword(userId: string, passwordHash: string): Promise<void> {
  const res = await prisma.user.updateMany({ where: { id: userId, passwordHash: null, role: "CUSTOMER" }, data: { passwordHash } });
  if (res.count !== 1) throw new UserFacingError("This account already has a password.");
}
