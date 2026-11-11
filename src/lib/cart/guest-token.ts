import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";

const GUEST_TOKEN_COOKIE = "guest_cart_token";
const GUEST_TOKEN_MAX_AGE = 60 * 60 * 24 * 60; // 60 days

/**
 * Returns the current guest cart token, creating and persisting a new one
 * if none exists yet. Only used when there is no authenticated user.
 */
export async function getOrCreateGuestToken(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(GUEST_TOKEN_COOKIE)?.value;
  if (existing) return existing;

  const token = crypto.randomUUID();
  cookieStore.set(GUEST_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: GUEST_TOKEN_MAX_AGE,
  });
  return token;
}

/** Reads the guest cart token if one exists, without creating a new one. */
export async function peekGuestToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(GUEST_TOKEN_COOKIE)?.value ?? null;
}

export async function clearGuestToken() {
  const cookieStore = await cookies();
  cookieStore.delete(GUEST_TOKEN_COOKIE);
}
