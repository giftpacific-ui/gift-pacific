import { createHmac } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type CryptoKey, type KeyObject, type JWK } from "jose";
import { providerConfig } from "@/lib/oauth/config";
import type { OAuthProviderName } from "@/lib/oauth/linking";

export type OAuthProfile = {
  providerAccountId: string;
  email: string | null;
  /** True only when the PROVIDER vouches for the address. Facebook never does. */
  emailVerified: boolean;
  name: string | null;
};

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const FB_VERSION = "v19.0";
const FB_AUTH = `https://www.facebook.com/${FB_VERSION}/dialog/oauth`;
const FB_TOKEN = `https://graph.facebook.com/${FB_VERSION}/oauth/access_token`;
const FB_ME = `https://graph.facebook.com/${FB_VERSION}/me`;

export class OAuthError extends Error {}

export function buildAuthorizeUrl(
  provider: OAuthProviderName,
  p: { state: string; nonce: string; challenge: string },
): string | null {
  const cfg = providerConfig(provider);
  if (!cfg) return null;
  const url = new URL(provider === "GOOGLE" ? GOOGLE_AUTH : FB_AUTH);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", p.state);
  if (provider === "GOOGLE") {
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("nonce", p.nonce);
    url.searchParams.set("code_challenge", p.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
  } else {
    url.searchParams.set("scope", "email,public_profile");
  }
  return url.toString();
}

type Fetch = typeof fetch;
const TIMEOUT = () => AbortSignal.timeout(8000);

export type GoogleKeyResolver = JWTVerifyGetKey | CryptoKey | KeyObject | JWK | Uint8Array;
let remoteKeys: JWTVerifyGetKey | null = null;

/** Verifies a Google ID token: signature (Google's JWKS), issuer, audience, expiry and nonce. */
export async function verifyGoogleIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; keys?: GoogleKeyResolver },
): Promise<OAuthProfile> {
  remoteKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS));
  const resolver = (opts.keys ?? remoteKeys) as never;
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, resolver, { issuer: GOOGLE_ISSUERS, audience: opts.clientId, algorithms: ["RS256"] }));
  } catch {
    throw new OAuthError("invalid_id_token");
  }
  if (typeof payload.nonce !== "string" || payload.nonce !== opts.nonce) throw new OAuthError("nonce_mismatch");
  if (typeof payload.sub !== "string" || !payload.sub) throw new OAuthError("no_subject");
  const email = typeof payload.email === "string" && payload.email.includes("@") ? payload.email.trim().toLowerCase() : null;
  const verified = payload.email_verified === true || payload.email_verified === "true";
  return {
    providerAccountId: payload.sub,
    email,
    emailVerified: Boolean(email) && verified,
    name: typeof payload.name === "string" ? payload.name : null,
  };
}

export async function fetchProfile(
  provider: OAuthProviderName,
  p: { code: string; verifier: string; nonce: string; fetchImpl?: Fetch; keys?: GoogleKeyResolver },
): Promise<OAuthProfile> {
  const cfg = providerConfig(provider);
  if (!cfg) throw new OAuthError("provider_not_configured");
  const doFetch = p.fetchImpl ?? fetch;

  if (provider === "GOOGLE") {
    const res = await doFetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: p.code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri, grant_type: "authorization_code", code_verifier: p.verifier,
      }),
      signal: TIMEOUT(),
      cache: "no-store",
    });
    if (!res.ok) throw new OAuthError(`token_exchange_failed_${res.status}`);
    const json = (await res.json()) as { id_token?: string };
    if (!json.id_token) throw new OAuthError("no_id_token");
    return verifyGoogleIdToken(json.id_token, { clientId: cfg.clientId, nonce: p.nonce, keys: p.keys });
  }

  // Facebook: server-to-server code exchange, then the Graph API with an appsecret_proof.
  const tokenUrl = new URL(FB_TOKEN);
  tokenUrl.searchParams.set("client_id", cfg.clientId);
  tokenUrl.searchParams.set("client_secret", cfg.clientSecret);
  tokenUrl.searchParams.set("redirect_uri", cfg.redirectUri);
  tokenUrl.searchParams.set("code", p.code);
  const tokenRes = await doFetch(tokenUrl, { signal: TIMEOUT(), cache: "no-store" });
  if (!tokenRes.ok) throw new OAuthError(`token_exchange_failed_${tokenRes.status}`);
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
  if (!accessToken) throw new OAuthError("no_access_token");
  const meUrl = new URL(FB_ME);
  meUrl.searchParams.set("fields", "id,name,email");
  meUrl.searchParams.set("access_token", accessToken);
  meUrl.searchParams.set("appsecret_proof", createHmac("sha256", cfg.clientSecret).update(accessToken).digest("hex"));
  const meRes = await doFetch(meUrl, { signal: TIMEOUT(), cache: "no-store" });
  if (!meRes.ok) throw new OAuthError(`profile_failed_${meRes.status}`);
  const me = (await meRes.json()) as { id?: string; name?: string; email?: string };
  if (!me.id || typeof me.id !== "string") throw new OAuthError("no_subject");
  const email = typeof me.email === "string" && me.email.includes("@") ? me.email.trim().toLowerCase() : null;
  // Facebook's email is NOT treated as verified: it may be missing, and is never used to link.
  return { providerAccountId: me.id, email, emailVerified: false, name: typeof me.name === "string" ? me.name : null };
}
