import "server-only";
import { SignJWT, jwtVerify } from "jose";
import type { UserRole } from "@prisma/client";

const SESSION_COOKIE_NAME = "session";
const ADMIN_SESSION_COOKIE_NAME = "admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type SessionPayload = {
  sub: string; // user id
  role: UserRole;
  email: string;
  name: string;
};

function getSecretKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(payload: SessionPayload) {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifySessionToken(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (
      typeof payload.sub !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.name !== "string"
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      role: payload.role as UserRole,
      email: payload.email,
      name: payload.name,
    };
  } catch {
    return null;
  }
}

export const sessionCookieConfig = {
  name: SESSION_COOKIE_NAME,
  maxAge: SESSION_MAX_AGE_SECONDS,
  options: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
};

/**
 * The admin panel uses a completely separate cookie from the customer
 * site — not just a `role` field inside a shared token. Customer account
 * pages and admin pages each read only their own cookie, so an admin
 * session can never be picked up by customer-facing auth helpers (and
 * vice versa) even by accident: there is no shared state to leak from.
 * `path: "/admin"` also means the browser only ever sends this cookie on
 * admin requests in the first place.
 */
export const adminSessionCookieConfig = {
  name: ADMIN_SESSION_COOKIE_NAME,
  maxAge: SESSION_MAX_AGE_SECONDS,
  options: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/admin",
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
};
