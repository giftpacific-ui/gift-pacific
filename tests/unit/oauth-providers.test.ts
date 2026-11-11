import { test, before } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair } from "jose";
import { appBaseUrl, enabledProviders, parseProvider, partiallyConfiguredProviders, providerConfig } from "@/lib/oauth/config";
import { buildAuthorizeUrl, fetchProfile, verifyGoogleIdToken, OAuthError } from "@/lib/oauth/providers";
import { newPkce, readOAuthState, readPendingLink, safeEqual, signOAuthState, signPendingLink } from "@/lib/oauth/state";
import { createHash } from "node:crypto";

before(() => { process.env.AUTH_SECRET = "test-secret-test-secret-test-secret-1234"; });

test("providers are enabled ONLY when both credentials and the public URL are present", () => {
  assert.deepEqual(enabledProviders({}), []);
  assert.deepEqual(enabledProviders({ NEXT_PUBLIC_APP_URL: "https://shop.test", GOOGLE_CLIENT_ID: "id" }), []);          // id without secret
  assert.deepEqual(enabledProviders({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }), []);                          // no public URL => no redirect URI
  assert.deepEqual(enabledProviders({ NEXT_PUBLIC_APP_URL: "https://shop.test/", GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: "s" }), ["GOOGLE"]);
  assert.deepEqual(enabledProviders({ NEXT_PUBLIC_APP_URL: "https://shop.test", FACEBOOK_APP_ID: "a", FACEBOOK_APP_SECRET: "b", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }), ["GOOGLE", "FACEBOOK"]);
  assert.equal(providerConfig("GOOGLE", { NEXT_PUBLIC_APP_URL: "https://shop.test/", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" })!.redirectUri, "https://shop.test/api/auth/oauth/google/callback");
  assert.deepEqual(partiallyConfiguredProviders({ GOOGLE_CLIENT_ID: "x", FACEBOOK_APP_ID: "a", FACEBOOK_APP_SECRET: "b" }), ["GOOGLE"]);
  assert.equal(appBaseUrl({ NEXT_PUBLIC_APP_URL: "javascript:alert(1)" }), null);
  assert.equal(parseProvider("google"), "GOOGLE");
  assert.equal(parseProvider("twitter"), null);
  assert.equal(parseProvider("__proto__"), null);
});

const env = () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://shop.test";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.FACEBOOK_APP_ID = "fb-app";
  process.env.FACEBOOK_APP_SECRET = "fb-secret";
};

test("authorize URLs carry state, PKCE (Google nonce) and never the client secret", () => {
  env();
  const g = new URL(buildAuthorizeUrl("GOOGLE", { state: "S", nonce: "N", challenge: "C" })!);
  assert.equal(g.origin + g.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual([g.searchParams.get("state"), g.searchParams.get("nonce"), g.searchParams.get("code_challenge"), g.searchParams.get("code_challenge_method"), g.searchParams.get("response_type")], ["S", "N", "C", "S256", "code"]);
  assert.equal(g.searchParams.get("redirect_uri"), "https://shop.test/api/auth/oauth/google/callback");
  assert.ok(!g.toString().includes("google-secret"));
  const f = new URL(buildAuthorizeUrl("FACEBOOK", { state: "S", nonce: "N", challenge: "C" })!);
  assert.equal(f.searchParams.get("state"), "S");
  assert.ok(!f.toString().includes("fb-secret"));
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal(buildAuthorizeUrl("GOOGLE", { state: "S", nonce: "N", challenge: "C" }), null);   // not configured => no URL
});

test("PKCE challenge is the S256 of the verifier", () => {
  const { verifier, challenge } = newPkce();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(newPkce().verifier, verifier);
});

test("signed state cookie: round-trips, rejects tampering, wrong purpose, garbage and expiry", async () => {
  const data = { provider: "GOOGLE" as const, state: "s1", nonce: "n1", verifier: "v1", redirectTo: "/account" };
  const token = await signOAuthState(data);
  assert.deepEqual(await readOAuthState(token), data);
  assert.equal(await readOAuthState(token.slice(0, -2) + "xx"), null);
  assert.equal(await readOAuthState("garbage"), null);
  assert.equal(await readOAuthState(undefined), null);
  assert.equal(await readOAuthState(await signPendingLink({ provider: "GOOGLE", providerAccountId: "1", email: "a@x.com" })), null); // a link token is not a state token
  const expired = await new SignJWT({ ...data, purpose: "oauth_state" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(new TextEncoder().encode(process.env.AUTH_SECRET));
  assert.equal(await readOAuthState(expired), null);
  const other = await new SignJWT({ ...data, purpose: "oauth_state" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("10m").sign(new TextEncoder().encode("a-different-secret-a-different-secret-12"));
  assert.equal(await readOAuthState(other), null);
  const link = await signPendingLink({ provider: "FACEBOOK", providerAccountId: "9", email: "b@x.com" });
  assert.deepEqual(await readPendingLink(link), { provider: "FACEBOOK", providerAccountId: "9", email: "b@x.com" });
  assert.equal(await readPendingLink(token), null);
  assert.ok(safeEqual("abc", "abc") && !safeEqual("abc", "abd") && !safeEqual("abc", "abcd"));
});

test("Google ID token: valid token accepted; wrong audience, issuer, nonce, expiry, signature all rejected", async () => {
  env();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const sign = (claims: Record<string, unknown>, o: { aud?: string; iss?: string; exp?: string | number; key?: typeof privateKey } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuer(o.iss ?? "https://accounts.google.com").setAudience(o.aud ?? "google-client")
      .setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(o.key ?? privateKey);
  const ok = { sub: "123", email: "Jo@X.com", email_verified: true, name: "Jo", nonce: "N" };
  const verify = (token: string, nonce = "N") => verifyGoogleIdToken(token, { clientId: "google-client", nonce, keys: publicKey });
  assert.deepEqual(await verify(await sign(ok)), { providerAccountId: "123", email: "jo@x.com", emailVerified: true, name: "Jo" });
  assert.equal((await verify(await sign({ ...ok, email_verified: "true" }))).emailVerified, true);
  assert.equal((await verify(await sign({ ...ok, email_verified: false }))).emailVerified, false);
  assert.equal((await verify(await sign({ sub: "1", nonce: "N" }))).email, null);
  for (const [label, token, nonce] of [
    ["wrong audience", await sign(ok, { aud: "someone-else" }), "N"],
    ["wrong issuer", await sign(ok, { iss: "https://evil.test" }), "N"],
    ["expired", await sign(ok, { exp: Math.floor(Date.now() / 1000) - 60 }), "N"],
    ["wrong signing key", await sign(ok, { key: other.privateKey }), "N"],
    ["wrong nonce", await sign(ok), "DIFFERENT"],
    ["no nonce", await sign({ sub: "1", email: "a@x.com", email_verified: true }), "N"],
    ["no subject", await sign({ nonce: "N", email: "a@x.com" }), "N"],
  ] as const) {
    await assert.rejects(verify(token, nonce), OAuthError, label);
  }
  await assert.rejects(verify("not-a-jwt"), OAuthError);
});

test("Google code exchange posts the verifier and secret server-side; failures are errors, never a login", async () => {
  env();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const idToken = await new SignJWT({ sub: "42", email: "a@x.com", email_verified: true, nonce: "N" }).setProtectedHeader({ alg: "RS256" }).setIssuer("https://accounts.google.com").setAudience("google-client").setExpirationTime("5m").sign(privateKey);
  let seen: { url: string; body: string } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => { seen = { url: String(url), body: String(init.body) }; return new Response(JSON.stringify({ id_token: idToken }), { status: 200 }); }) as never;
  const profile = await fetchProfile("GOOGLE", { code: "CODE", verifier: "VER", nonce: "N", fetchImpl, keys: publicKey });
  assert.equal(profile.providerAccountId, "42");
  assert.match(seen!.body, /code_verifier=VER/);
  assert.match(seen!.body, /grant_type=authorization_code/);
  const denied = (async () => new Response("no", { status: 400 })) as never;
  await assert.rejects(fetchProfile("GOOGLE", { code: "x", verifier: "v", nonce: "N", fetchImpl: denied, keys: publicKey }), /token_exchange_failed_400/);
  const noToken = (async () => new Response("{}", { status: 200 })) as never;
  await assert.rejects(fetchProfile("GOOGLE", { code: "x", verifier: "v", nonce: "N", fetchImpl: noToken, keys: publicKey }), /no_id_token/);
});

test("Facebook: Graph API called with appsecret_proof; email is NEVER treated as verified", async () => {
  env();
  const urls: string[] = [];
  const fetchImpl = (async (url: URL) => {
    urls.push(String(url));
    if (new URL(String(url)).pathname.includes("/oauth/access_token")) return new Response(JSON.stringify({ access_token: "TOKEN" }), { status: 200 });
    return new Response(JSON.stringify({ id: "fb-1", name: "Jo", email: "JO@x.com" }), { status: 200 });
  }) as never;
  const p = await fetchProfile("FACEBOOK", { code: "C", verifier: "v", nonce: "n", fetchImpl });
  assert.deepEqual(p, { providerAccountId: "fb-1", email: "jo@x.com", emailVerified: false, name: "Jo" });
  const proof = new URL(urls[1]).searchParams.get("appsecret_proof");
  assert.match(proof!, /^[0-9a-f]{64}$/);
  const noEmail = (async (url: URL) => new URL(String(url)).pathname.includes("/oauth/access_token") ? new Response(JSON.stringify({ access_token: "T" })) : new Response(JSON.stringify({ id: "9" }))) as never;
  assert.equal((await fetchProfile("FACEBOOK", { code: "C", verifier: "v", nonce: "n", fetchImpl: noEmail })).email, null);
  const bad = (async () => new Response("x", { status: 500 })) as never;
  await assert.rejects(fetchProfile("FACEBOOK", { code: "C", verifier: "v", nonce: "n", fetchImpl: bad }), /token_exchange_failed_500/);
  delete process.env.FACEBOOK_APP_SECRET;
  await assert.rejects(fetchProfile("FACEBOOK", { code: "C", verifier: "v", nonce: "n", fetchImpl }), /provider_not_configured/);
});
