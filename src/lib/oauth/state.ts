import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { OAuthProviderName } from "@/lib/oauth/linking";

/**
 * The browser round-trip is protected by a short-lived, SIGNED, httpOnly cookie that binds the
 * `state` (login CSRF), `nonce` (ID-token replay) and PKCE verifier to THIS browser. The
 * callback must present the same `state` in the query string.
 */
export const OAUTH_STATE_COOKIE = "oauth_state";
export const OAUTH_LINK_COOKIE = "oauth_link";
export const OAUTH_COOKIE_MAX_AGE = 10 * 60;

const key = () => {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(secret);
};

const b64url = (buf: Buffer) => buf.toString("base64url");

export function newPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export type OAuthState = { provider: OAuthProviderName; state: string; nonce: string; verifier: string; redirectTo: string; /** Set only for "connect another account" flows started by a signed-in customer. */ linkUserId?: string };

export async function signOAuthState(data: OAuthState): Promise<string> {
  return new SignJWT({ ...data, purpose: "oauth_state" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${OAUTH_COOKIE_MAX_AGE}s`)
    .sign(key());
}

export async function readOAuthState(token: string | undefined): Promise<OAuthState | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (payload.purpose !== "oauth_state") return null;
    const { provider, state, nonce, verifier, redirectTo } = payload as Record<string, unknown>;
    if (typeof provider !== "string" || typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string" || typeof redirectTo !== "string") return null;
    const linkUserId = (payload as Record<string, unknown>).linkUserId;
    return { provider: provider as OAuthProviderName, state, nonce, verifier, redirectTo, ...(typeof linkUserId === "string" && linkUserId ? { linkUserId } : {}) };
  } catch {
    return null;
  }
}

export const newRandom = () => b64url(randomBytes(24));

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A social identity waiting to be attached after the user proves they own the local account. */
export type PendingLink = { provider: OAuthProviderName; providerAccountId: string; email: string };

export async function signPendingLink(data: PendingLink): Promise<string> {
  return new SignJWT({ ...data, purpose: "oauth_link" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${OAUTH_COOKIE_MAX_AGE}s`)
    .sign(key());
}

export async function readPendingLink(token: string | undefined): Promise<PendingLink | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (payload.purpose !== "oauth_link") return null;
    const { provider, providerAccountId, email } = payload as Record<string, unknown>;
    if (typeof provider !== "string" || typeof providerAccountId !== "string" || typeof email !== "string") return null;
    return { provider: provider as OAuthProviderName, providerAccountId, email };
  } catch {
    return null;
  }
}
