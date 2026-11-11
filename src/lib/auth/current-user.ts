import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/db/prisma";
import {
  sessionCookieConfig,
  adminSessionCookieConfig,
  verifySessionToken,
} from "@/lib/auth/session";

// ===========================================================================
// Customer auth — reads ONLY the customer "session" cookie. An admin's
// session lives in a completely separate cookie (see below) and is never
// visible here, so customer account/profile pages can never end up
// rendering an admin's identity just because an admin happens to be logged
// in in the same browser.
// ===========================================================================

/**
 * Reads and verifies the CUSTOMER session cookie for the current request,
 * AND confirms the user it names still exists, is active, and is actually
 * a CUSTOMER (not an admin account whose token somehow ended up here).
 *
 * A cryptographically valid JWT only proves the token wasn't tampered
 * with — it does NOT prove the user it names still exists in the
 * database. A stale cookie (left over from a dev database reset/reseed,
 * or from an account an admin later deleted/deactivated) would otherwise
 * carry a `sub` that has no matching User row. Several call sites
 * (cart, wishlist, order, checkout) feed `session.sub` straight into
 * FK-constrained writes like `Cart.userId` — without this check, a stale
 * session crashes those with a Prisma P2003 foreign-key violation instead
 * of behaving like a logged-out visitor.
 *
 * This check lives here, once, rather than being repeated (or missed) at
 * every call site — every consumer of `getSession()` gets the guarantee
 * that a non-null result names a real, active CUSTOMER.
 *
 * Cached per-request so multiple server components/actions calling this
 * don't each re-verify the JWT or re-query the user.
 */
export const getSession = cache(async () => {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieConfig.name)?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, isActive: true, role: true },
  });
  // Defense in depth: even though login now gates by role and the admin
  // and customer cookies are entirely separate, never treat a non-CUSTOMER
  // account as a valid customer session under any circumstance.
  if (!user || !user.isActive || user.role !== "CUSTOMER") return null;

  return payload;
});

/**
 * Returns the full, fresh CUSTOMER record from the database for the
 * current session, or null if not authenticated / not a customer / the
 * user was deactivated.
 */
export const getCurrentUser = cache(async () => {
  const session = await getSession();
  if (!session) return null;

  const user = await prisma.user.findUnique({ where: { id: session.sub } });
  if (!user || !user.isActive || user.role !== "CUSTOMER") return null;

  return user;
});

/** Throws if there is no authenticated customer. Use in server actions/route handlers. */
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("UNAUTHENTICATED");
  }
  return user;
}

// ===========================================================================
// Admin auth — reads ONLY the separate "admin_session" cookie (scoped to
// path "/admin", so the browser never even sends it on customer requests).
// Fully independent resolution path from the customer helpers above: an
// admin logging in never touches the customer cookie, and nothing here
// ever falls back to it.
// ===========================================================================

export const getAdminSession = cache(async () => {
  const cookieStore = await cookies();
  const token = cookieStore.get(adminSessionCookieConfig.name)?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, isActive: true, role: true },
  });
  if (!user || !user.isActive || user.role !== "ADMIN") return null;

  return payload;
});

export const getCurrentAdmin = cache(async () => {
  const session = await getAdminSession();
  if (!session) return null;

  const user = await prisma.user.findUnique({ where: { id: session.sub } });
  if (!user || !user.isActive || user.role !== "ADMIN") return null;

  return user;
});

/** Throws if there is no authenticated admin. Use in admin server actions/route handlers. */
export async function requireAdmin() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    throw new Error("FORBIDDEN");
  }
  return admin;
}
