import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { completeOAuthLogin, linkAfterPasswordLogin } from "@/server/services/oauth.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); });

const google = (over = {}) => ({ providerAccountId: "g-1", email: "jo@x.com", emailVerified: true, name: "Jo Doe", ...over });
const fb = (over = {}) => ({ providerAccountId: "fb-1", email: "jo@x.com", emailVerified: false, name: "Jo Doe", ...over });
const users = () => db.rows("user");
const accounts = () => db.rows("oAuthAccount");

test("first Google login creates a password-less CUSTOMER and links the provider account; no tokens are stored", async () => {
  const r = await completeOAuthLogin("GOOGLE", google());
  assert.equal(r.status, "ok");
  assert.equal(users().length, 1);
  const u = users()[0];
  assert.deepEqual([u.email, u.role, u.passwordHash, u.name], ["jo@x.com", "CUSTOMER", null, "Jo Doe"]);
  assert.ok(u.emailVerified instanceof Date);                         // Google vouched for the email
  assert.equal(accounts().length, 1);
  assert.equal(accounts()[0].providerAccountId, "g-1");
  assert.ok(!Object.keys(accounts()[0]).some((k) => /token|secret/i.test(k)));
});

test("Facebook sign-up: account created, but the email is recorded as NOT verified", async () => {
  await completeOAuthLogin("FACEBOOK", fb());
  assert.equal(users()[0].emailVerified, null);
  assert.equal(accounts()[0].emailVerifiedByProvider, false);
});

test("a returning user signs in to the SAME account (no duplicates), even if the provider email changed", async () => {
  await completeOAuthLogin("GOOGLE", google());
  const r = await completeOAuthLogin("GOOGLE", google({ email: "new-address@x.com" }));
  assert.equal(r.status, "ok");
  assert.equal(users().length, 1);
  assert.equal(accounts().length, 1);
  assert.ok(accounts()[0].lastLoginAt instanceof Date);
});

test("PRE-HIJACK: an existing password account is NOT linked or logged into; the identity waits for a password", async () => {
  db.insert("user", { id: "victim", name: "Victim", email: "jo@x.com", passwordHash: "bcrypt-hash", role: "CUSTOMER", isActive: true });
  const r = await completeOAuthLogin("GOOGLE", google());
  assert.deepEqual(r, { status: "needs_password", email: "jo@x.com" });
  assert.equal(accounts().length, 0);                                  // nothing attached
  assert.equal(users().length, 1);                                     // nothing created
});

test("admins can never be created, linked or signed in through social login", async () => {
  db.insert("user", { id: "boss", name: "Boss", email: "jo@x.com", passwordHash: "h", role: "ADMIN", isActive: true });
  for (const profile of [google(), fb()]) {
    assert.deepEqual(await completeOAuthLogin(profile.providerAccountId.startsWith("g") ? "GOOGLE" : "FACEBOOK", profile), { status: "refused", reason: "admin_email" });
  }
  assert.equal(accounts().length, 0);
  // even a provider account that was somehow linked to an admin cannot log in
  db.insert("oAuthAccount", { id: "x", userId: "boss", provider: "GOOGLE", providerAccountId: "g-9" });
  assert.deepEqual(await completeOAuthLogin("GOOGLE", google({ providerAccountId: "g-9" })), { status: "refused", reason: "admin_email" });
});

test("deactivated accounts are refused; no-email profiles create nothing", async () => {
  db.insert("user", { id: "u1", name: "Off", email: "jo@x.com", passwordHash: "h", role: "CUSTOMER", isActive: false });
  assert.deepEqual(await completeOAuthLogin("GOOGLE", google()), { status: "refused", reason: "inactive" });
  assert.deepEqual(await completeOAuthLogin("FACEBOOK", fb({ email: null })), { status: "refused", reason: "no_email" });
  assert.equal(accounts().length, 0);
  assert.equal(users().length, 1);
});

test("a social-only account links a second provider only when that provider verifies the email", async () => {
  await completeOAuthLogin("GOOGLE", google());
  assert.deepEqual(await completeOAuthLogin("FACEBOOK", fb()), { status: "refused", reason: "use_other_method" });
  assert.equal(accounts().length, 1);
    // A DIFFERENT Google identity with the same email cannot take over the account either.
  assert.deepEqual(await completeOAuthLogin("GOOGLE", google({ providerAccountId: "g-2" })), { status: "refused", reason: "use_other_method" });
  assert.equal(accounts().length, 1);
  assert.equal(users().length, 1);
});

test("linking after a password sign-in: only for the same email, never for admins, never steals a linked identity", async () => {
  db.insert("user", { id: "u1", name: "Jo", email: "jo@x.com", passwordHash: "h", role: "CUSTOMER", isActive: true });
  const pending = { provider: "GOOGLE" as const, providerAccountId: "g-1", email: "jo@x.com" };
  assert.equal(await linkAfterPasswordLogin({ id: "u1", email: "other@x.com", role: "CUSTOMER" }, pending), false);   // different email
  assert.equal(await linkAfterPasswordLogin({ id: "u1", email: "jo@x.com", role: "ADMIN" }, pending), false);          // admin
  assert.equal(accounts().length, 0);
  assert.equal(await linkAfterPasswordLogin({ id: "u1", email: "JO@x.com", role: "CUSTOMER" }, pending), true);
  assert.equal(accounts().length, 1);
  db.insert("user", { id: "u2", name: "Mal", email: "jo@x.com ", passwordHash: "h", role: "CUSTOMER", isActive: true });
  assert.equal(await linkAfterPasswordLogin({ id: "u2", email: "jo@x.com", role: "CUSTOMER" }, pending), false);       // already linked to u1
  assert.equal(accounts()[0].userId, "u1");
  // after linking, the Google login signs the user in
  assert.deepEqual((await completeOAuthLogin("GOOGLE", google())).status, "ok");
});
