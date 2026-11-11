/**
 * Account-linking policy for social login. PURE: no I/O, so every case is unit-tested.
 *
 * Why matching on email alone is NOT enough: local registration here never verifies email
 * ownership (there is no email provider). If a Google login were merged into any local
 * account with the same email, an attacker could pre-register a victim's email with a
 * password of their own, wait for the victim to "Sign in with Google", and keep a working
 * password on the victim's account. So:
 *   - an existing account that HAS a password is linked only after a successful password
 *     sign-in (proof of ownership), never automatically;
 *   - admins can never be created, linked or authenticated through a social provider;
 *   - a provider email is only trusted to link when the provider says it is verified.
 */
export type OAuthProviderName = "GOOGLE" | "FACEBOOK";

export type LinkingInput = {
  /** The user already linked to this provider account (provider + provider id), if any. */
  linkedUser: { id: string; role: string; isActive: boolean } | null;
  /** The user whose email equals the provider's email, if any. */
  emailUser: { id: string; role: string; isActive: boolean; hasPassword: boolean } | null;
  profile: { email: string | null; emailVerified: boolean };
};

export type RefuseReason = "inactive" | "admin_email" | "no_email" | "use_other_method";

export type LinkingDecision =
  | { type: "login"; userId: string }
  | { type: "create" }
  | { type: "link_login"; userId: string }
  | { type: "needs_password"; userId: string }
  | { type: "refuse"; reason: RefuseReason };

export function decideLinking(input: LinkingInput): LinkingDecision {
  const { linkedUser, emailUser, profile } = input;

  if (linkedUser) {
    if (linkedUser.role !== "CUSTOMER") return { type: "refuse", reason: "admin_email" };
    if (!linkedUser.isActive) return { type: "refuse", reason: "inactive" };
    return { type: "login", userId: linkedUser.id };
  }

  if (!profile.email) return { type: "refuse", reason: "no_email" };

  if (!emailUser) return { type: "create" };

  if (emailUser.role !== "CUSTOMER") return { type: "refuse", reason: "admin_email" };
  if (!emailUser.isActive) return { type: "refuse", reason: "inactive" };

  // Existing local account with a password: prove ownership with that password first.
  if (emailUser.hasPassword) return { type: "needs_password", userId: emailUser.id };

  // A social-only account (created through another provider). Only a provider that VOUCHES
  // for the email may be attached to it automatically.
  if (profile.emailVerified) return { type: "link_login", userId: emailUser.id };
  return { type: "refuse", reason: "use_other_method" };
}

export const REFUSE_MESSAGES: Record<RefuseReason, string> = {
  inactive: "This account is not active. Please contact the store.",
  admin_email: "This email can't be used with social sign-in. Please use the regular sign-in form.",
  no_email: "Your provider did not share an email address with us. Please allow email access, or register with email.",
  use_other_method: "An account with this email already exists. Please sign in the way you did before.",
};
