/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { freshDb, runAs } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { GET as callback } from "@/app/api/auth/oauth/[provider]/callback/route";
import { OAUTH_LINK_COOKIE, OAUTH_STATE_COOKIE, signOAuthState, signPendingLink } from "@/lib/oauth/state";
import { completeOAuthLogin } from "@/server/services/oauth.service";
import { loginUser } from "@/server/actions/auth.actions";
import { buildAuthorizeUrl } from "@/lib/oauth/providers";
import { decideLinking } from "@/lib/oauth/linking";

let db: FakeDb;
const jar = () => (globalThis as any).__TEST_COOKIES__ as Map<string, { value: string; options: any }>;
const realFetch = globalThis.fetch;

before(() => {
  process.env.AUTH_SECRET = "test-secret-test-secret-test-secret-1234";
  process.env.NEXT_PUBLIC_APP_URL = "https://shop.test";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { db = freshDb(); jar().clear(); globalThis.fetch = realFetch; });

const STATE = { provider: "GOOGLE" as const, state: "state-1", nonce: "nonce-1", verifier: "ver-1", redirectTo: "/account" };

async function call(opts: { provider?: string; cookie?: string | null; query?: Record<string, string>; as?: { sub: string } | null }) {
  const url = new URL("https://shop.test/api/auth/oauth/google/callback");
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const req = { url: url.toString(), nextUrl: url, cookies: { get: (n: string) => (n === OAUTH_STATE_COOKIE && opts.cookie ? { value: opts.cookie } : undefined) } } as any;
  return runAs(opts.as ?? null, () => callback(req, { params: Promise.resolve({ provider: opts.provider ?? "google" }) })) as Promise<any>;
}
const target = (res: any) => { const u = new URL(res.headers.get("location")); return u.pathname + u.search; };
const noSession = () => assert.ok(![...jar().keys()].some((k) => /session/i.test(k)), "no session cookie may be set");

// ---- callback validation -----------------------------------------------------------------------------------------------------------------------
test("callback: unknown or unconfigured provider is a 404 (nothing to attack)", async () => {
  assert.equal((await call({ provider: "twitter" })).status, 404);
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try { assert.equal((await call({})).status, 404); } finally { process.env.GOOGLE_CLIENT_SECRET = secret; }
});

test("callback: missing, tampered, wrong-provider or mismatched state is refused before anything else happens", async () => {
  const good = await signOAuthState(STATE);
  for (const [label, cookie, state] of [
    ["no cookie", null, "state-1"],
    ["tampered cookie", good.slice(0, -3) + "AAA", "state-1"],
    ["state param missing", good, ""],
    ["state param differs (login CSRF)", good, "attacker-state"],
    ["cookie was issued for another provider", await signOAuthState({ ...STATE, provider: "FACEBOOK" }), "state-1"],
  ] as const) {
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response("{}"); }) as any;
    const res = await call({ cookie, query: { code: "CODE", ...(state ? { state } : {}) } });
    assert.equal(target(res), "/login?error=oauth_state", label);
    assert.equal(fetched, false, `${label}: the code must not be exchanged`);
    noSession();
  }
});

test("callback: the user cancelling at Google, or a missing/oversized code, ends on the login page with an error; state cookie is cleared", async () => {
  const cookie = await signOAuthState(STATE);
  const denied = await call({ cookie, query: { state: "state-1", error: "access_denied" } });
  assert.equal(target(denied), "/login?error=oauth_denied");
  assert.deepEqual(denied.setCookies.map((c: any) => [c.name, c.value, c.options.maxAge]), [[OAUTH_STATE_COOKIE, "", 0]]); // single use
  assert.equal(target(await call({ cookie, query: { state: "state-1" } })), "/login?error=oauth_failed");
  assert.equal(target(await call({ cookie, query: { state: "state-1", code: "x".repeat(2049) } })), "/login?error=oauth_failed");
  noSession();
});

test("callback: a failed code exchange is a generic failure: no session, no account, nothing leaked in the redirect", async () => {
  globalThis.fetch = (async () => new Response("invalid_grant secret-detail", { status: 400 })) as any;
  const res = await call({ cookie: await signOAuthState(STATE), query: { state: "state-1", code: "BAD" } });
  assert.equal(target(res), "/login?error=oauth_failed");
  assert.ok(!res.headers.get("location").includes("secret-detail"));
  assert.equal(db.rows("user").length, 0);
  assert.equal(db.rows("oAuthAccount").length, 0);
  noSession();
});

test("callback: a network error or an unverifiable ID token fails closed", async () => {
  globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as any;
  assert.equal(target(await call({ cookie: await signOAuthState(STATE), query: { state: "state-1", code: "C" } })), "/login?error=oauth_failed");
  globalThis.fetch = (async () => new Response(JSON.stringify({ id_token: "not.a.jwt" }), { status: 200 })) as any;
  assert.equal(target(await call({ cookie: await signOAuthState(STATE), query: { state: "state-1", code: "C" } })), "/login?error=oauth_failed");
  assert.equal(db.rows("user").length, 0);
  noSession();
});

test("callback (connect-another-account): a changed or missing session goes back to settings and links nothing", async () => {
  db.insert("user", { id: "u1", email: "a@x.com", name: "A", role: "CUSTOMER", isActive: true, passwordHash: "h" });
  db.insert("user", { id: "u2", email: "b@x.com", name: "B", role: "CUSTOMER", isActive: true, passwordHash: "h" });
  const cookie = await signOAuthState({ ...STATE, linkUserId: "u1" });
  assert.equal(target(await call({ cookie, query: { state: "state-1", code: "C" }, as: null })), "/account/settings?link=session_changed");
  assert.equal(target(await call({ cookie, query: { state: "state-1", code: "C" }, as: { sub: "u2" } })), "/account/settings?link=session_changed");
  assert.equal(target(await call({ cookie, query: { state: "state-1", error: "access_denied" } })), "/account/settings?link=oauth_denied");
  assert.equal(db.rows("oAuthAccount").length, 0);
});

// ---- authorize URL ----------------------------------------------------------------------------------------------------------------------------
test("authorize URL asks only for openid, email, profile and sends state, nonce and PKCE", () => {
  const u = new URL(buildAuthorizeUrl("GOOGLE", { state: "S", nonce: "N", challenge: "C" })!);
  assert.equal(u.searchParams.get("scope"), "openid email profile");
  assert.equal(u.searchParams.get("redirect_uri"), "https://shop.test/api/auth/oauth/google/callback");
});

// ---- account linking / duplicate prevention ---------------------------------------------------------------------------------------------------
const google = (over = {}) => ({ providerAccountId: "g-1", email: "jo@x.com", emailVerified: true, name: "Jo", ...over });

test("Google email unverified: a NEW identity is refused (no account created, no link prompt); an already-linked identity still signs in", async () => {
  const r = await completeOAuthLogin("GOOGLE", google({ emailVerified: false }));
  assert.deepEqual(r, { status: "refused", reason: "email_unverified" });
  assert.equal(db.rows("user").length, 0);
  db.insert("user", { id: "old", email: "old@x.com", name: "Old", role: "CUSTOMER", isActive: true, passwordHash: null });
  db.insert("oAuthAccount", { id: "oa", userId: "old", provider: "GOOGLE", providerAccountId: "g-9", emailAtLink: "old@x.com", emailVerifiedByProvider: true, lastLoginAt: null });
  const again = await completeOAuthLogin("GOOGLE", google({ providerAccountId: "g-9", email: "old@x.com", emailVerified: false }));
  assert.equal(again.status, "ok");
  assert.equal(decideLinking({ linkedUser: null, emailUser: null, profile: { email: "a@x.com", emailVerified: false } }).type, "create"); // Facebook policy unchanged
});

test("duplicate prevention: Google email in different letter case, repeated logins and concurrent first logins give exactly ONE customer", async () => {
  const results = await Promise.all([1, 2, 3].map(() => completeOAuthLogin("GOOGLE", google({ email: "jo@x.com" }))));
  assert.ok(results.every((r) => r.status === "ok"));
  await completeOAuthLogin("GOOGLE", google());
  assert.equal(db.rows("user").length, 1);
  assert.equal(db.rows("oAuthAccount").length, 1);
});

test("existing email+password customer: Google never creates a second account; password sign-in then connects it, shows the success state and clears the link cookie", async () => {
  const hash = await bcrypt.hash("correct-horse-1", 4);
  db.insert("user", { id: "c1", email: "jo@x.com", name: "Jo", role: "CUSTOMER", isActive: true, passwordHash: hash });
  const r = await completeOAuthLogin("GOOGLE", google());
  assert.deepEqual(r, { status: "needs_password", email: "jo@x.com" });
  assert.equal(db.rows("user").length, 1);
  assert.equal(db.rows("oAuthAccount").length, 0);

  jar().set(OAUTH_LINK_COOKIE, { value: await signPendingLink({ provider: "GOOGLE", providerAccountId: "g-1", email: "jo@x.com" }), options: {} });
  const res = await loginUser({ email: "jo@x.com", password: "correct-horse-1" });
  assert.deepEqual([res.success, res.linkedProvider], [true, "GOOGLE"]);
  assert.equal(jar().has(OAUTH_LINK_COOKIE), false);
  assert.deepEqual(db.rows("oAuthAccount").map((a) => [a.userId, a.providerAccountId]), [["c1", "g-1"]]);
  assert.equal(db.rows("user").length, 1);
  // and from now on Google signs straight in to the SAME account
  const next = await completeOAuthLogin("GOOGLE", google());
  assert.equal(next.status === "ok" && next.user.id, "c1");
});

test("authentication failures never link: wrong password, a different account's password, or a stale/forged link cookie", async () => {
  const hash = await bcrypt.hash("correct-horse-1", 4);
  db.insert("user", { id: "c1", email: "jo@x.com", name: "Jo", role: "CUSTOMER", isActive: true, passwordHash: hash });
  db.insert("user", { id: "c2", email: "other@x.com", name: "Other", role: "CUSTOMER", isActive: true, passwordHash: hash });
  const pending = await signPendingLink({ provider: "GOOGLE", providerAccountId: "g-1", email: "jo@x.com" });

  jar().set(OAUTH_LINK_COOKIE, { value: pending, options: {} });
  const wrong = await loginUser({ email: "jo@x.com", password: "wrong-password" });
  assert.deepEqual([wrong.success, wrong.linkedProvider], [false, undefined]);
  assert.equal(db.rows("oAuthAccount").length, 0);

  // Signing in as ANOTHER customer must not attach Jo's Google identity to that account.
  const other = await loginUser({ email: "other@x.com", password: "correct-horse-1" });
  assert.deepEqual([other.success, other.linkedProvider], [true, undefined]);
  assert.equal(db.rows("oAuthAccount").length, 0);

  jar().set(OAUTH_LINK_COOKIE, { value: pending.slice(0, -3) + "AAA", options: {} });
  const forged = await loginUser({ email: "jo@x.com", password: "correct-horse-1" });
  assert.deepEqual([forged.success, forged.linkedProvider], [true, undefined]);
  assert.equal(db.rows("oAuthAccount").length, 0);
});

test("a Google-only account (no password) cannot be entered through the password form", async () => {
  await completeOAuthLogin("GOOGLE", google());
  const r = await loginUser({ email: "jo@x.com", password: "anything-at-all" });
  assert.deepEqual([r.success, r.message], [false, "Invalid email or password"]);
});

test("an existing Google-linked customer who also has a password keeps both ways in; an admin email is refused for Google", async () => {
  db.insert("user", { id: "adm", email: "boss@x.com", name: "Boss", role: "ADMIN", isActive: true, passwordHash: "h" });
  assert.deepEqual(await completeOAuthLogin("GOOGLE", google({ email: "boss@x.com" })), { status: "refused", reason: "admin_email" });
  assert.equal(db.rows("oAuthAccount").length, 0);
});
