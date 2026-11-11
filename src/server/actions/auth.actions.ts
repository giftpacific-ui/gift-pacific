"use server";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSessionToken, sessionCookieConfig, adminSessionCookieConfig } from "@/lib/auth/session";
import { mergeGuestCartIntoUserCart } from "@/server/services/cart.service";
import { peekGuestToken, clearGuestToken } from "@/lib/cart/guest-token";
import { OAUTH_LINK_COOKIE, readPendingLink } from "@/lib/oauth/state";
import { linkAfterPasswordLogin } from "@/server/services/oauth.service";
import { RATE_LIMITS, clientAddress, consumeRateLimit, throttledMessage } from "@/lib/rate-limit";
import {
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from "@/lib/validations/auth";

export type AuthActionState = {
  success: boolean;
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

async function establishCustomerSession(user: {
  id: string;
  role: "ADMIN" | "CUSTOMER";
  email: string;
  name: string;
}) {
  const token = await createSessionToken({
    sub: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
  });
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieConfig.name, token, sessionCookieConfig.options);
}

async function establishAdminSession(user: {
  id: string;
  role: "ADMIN" | "CUSTOMER";
  email: string;
  name: string;
}) {
  const token = await createSessionToken({
    sub: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
  });
  const cookieStore = await cookies();
  cookieStore.set(adminSessionCookieConfig.name, token, adminSessionCookieConfig.options);
}

/**
 * Folds any items from the visitor's pre-login guest cart into their
 * now-authenticated cart, then drops the now-empty guest cookie.
 * `mergeGuestCartIntoUserCart` was previously written but never called
 * from anywhere — guest cart items were silently lost on every
 * login/registration. Called after establishCustomerSession() so this always
 * runs for both new registrations and existing logins.
 */
async function mergeGuestCartIfPresent(userId: string) {
  const guestToken = await peekGuestToken();
  if (!guestToken) return;
  await mergeGuestCartIntoUserCart(userId, guestToken);
  await clearGuestToken();
}

export async function registerUser(
  input: RegisterInput,
): Promise<AuthActionState> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { name, email, phone, password } = parsed.data;
  const throttle = await consumeRateLimit(RATE_LIMITS.register, [await clientAddress()]);
  if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return {
      success: false,
      fieldErrors: { email: ["An account with this email already exists"] },
    };
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone: phone || null,
      passwordHash,
      role: "CUSTOMER",
    },
  });

  // Every customer gets an empty cart + wishlist ready to use.
  await prisma.$transaction([
    prisma.cart.create({ data: { userId: user.id } }),
    prisma.wishlist.create({ data: { userId: user.id } }),
  ]);

    await establishCustomerSession(user);
  await mergeGuestCartIfPresent(user.id);

  return { success: true };
}

/**
 * If the customer came from "Continue with Google/Facebook" and an account with that email
 * already existed, the social identity was parked in a signed cookie. Now that they have
 * proved ownership with the password, attach it. The cookie is single-use.
 */
async function completePendingSocialLink(user: { id: string; email: string; role: string }) {
  const store = await cookies();
  const pending = await readPendingLink(store.get(OAUTH_LINK_COOKIE)?.value);
  if (!pending) return;
  store.delete(OAUTH_LINK_COOKIE);
  await linkAfterPasswordLogin(user, pending);
}

export async function loginUser(input: LoginInput): Promise<AuthActionState> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { email, password } = parsed.data;
  const ip = await clientAddress();
  const throttle = await consumeRateLimit(RATE_LIMITS.loginIp, [ip]);
  const accountThrottle = throttle.ok
    ? await consumeRateLimit(RATE_LIMITS.loginAccount, [`${ip}|${email}`])
    : throttle;
  if (!accountThrottle.ok) return { success: false, message: throttledMessage(accountThrottle) };

  const user = await prisma.user.findUnique({ where: { email } });
  // Generic "Invalid email or password" for every failure case, including
  // "this account exists but isn't a customer account" — the customer
  // login form must never become a way to authenticate an admin account,
  // and must not reveal account existence/role either.
  if (!user || !user.isActive || user.role !== "CUSTOMER") {
    return { success: false, message: "Invalid email or password" };
  }

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    return { success: false, message: "Invalid email or password" };
  }

  await establishCustomerSession(user);
  await mergeGuestCartIfPresent(user.id);
  await completePendingSocialLink(user);

  return { success: true };
}

export async function loginAdmin(input: LoginInput): Promise<AuthActionState> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { email, password } = parsed.data;
  const ip = await clientAddress();
  const throttle = await consumeRateLimit(RATE_LIMITS.adminLoginIp, [ip]);
  const accountThrottle = throttle.ok
    ? await consumeRateLimit(RATE_LIMITS.adminLoginAccount, [`${ip}|${email}`])
    : throttle;
  if (!accountThrottle.ok) return { success: false, message: throttledMessage(accountThrottle) };

  const user = await prisma.user.findUnique({ where: { email } });
  // Same generic message for every failure case, including "this account
  // exists but isn't an admin account" — the admin login form must never
  // become a way to authenticate a customer account into the admin
  // session, and must not reveal account existence/role either.
  if (!user || !user.isActive || user.role !== "ADMIN") {
    return { success: false, message: "Invalid email or password" };
  }

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    return { success: false, message: "Invalid email or password" };
  }

  await establishAdminSession(user);
  // Deliberately no mergeGuestCartIfPresent() here — admins don't have
  // shopping carts, and an admin login must not touch the customer-side
  // guest cart cookie at all.

  return { success: true };
}

export async function logoutUser() {
  const cookieStore = await cookies();
  cookieStore.delete(sessionCookieConfig.name);
}

export async function logoutAdmin() {
  const cookieStore = await cookies();
  cookieStore.delete({ name: adminSessionCookieConfig.name, path: "/admin" });
}
