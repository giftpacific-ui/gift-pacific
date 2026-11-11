import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../setup/helpers";
import type { FakeDb } from "../setup/fake-db";
import { completeOAuthLogin, linkProviderToUser } from "@/server/services/oauth.service";
import { getConnectedAccounts, unlinkProvider, setInitialPassword, canRemoveProvider } from "@/server/services/connected-accounts.service";

let db: FakeDb;
beforeEach(() => { db = freshDb(); });

const google = { providerAccountId: "g-1", email: "jo@x.com", emailVerified: true, name: "Jo Doe" };
const fb = { providerAccountId: "fb-1", email: "jo@x.com", emailVerified: false, name: "Jo Doe" };
const userId = () => db.rows("user")[0].id as string;

test("rule: removal needs a password or a second provider", () => {
  assert.equal(canRemoveProvider(false, 1), false);
  assert.equal(canRemoveProvider(true, 1), true);
  assert.equal(canRemoveProvider(false, 2), true);
});

test("a social-only user cannot unlink their only sign-in method", async () => {
  await completeOAuthLogin("GOOGLE", google);
  const view = await getConnectedAccounts(userId());
  assert.equal(view.hasPassword, false);
  assert.equal(view.accounts[0].canUnlink, false);
  await assert.rejects(unlinkProvider(userId(), "GOOGLE"), /only way to sign in/);
  assert.equal(db.rows("oAuthAccount").length, 1);
});

test("after adding a password the provider can be unlinked; a second password cannot be set this way", async () => {
  await completeOAuthLogin("GOOGLE", google);
  await setInitialPassword(userId(), "hash-1");
  await assert.rejects(setInitialPassword(userId(), "hash-2"), /already has a password/);
  assert.equal(db.rows("user")[0].passwordHash, "hash-1");
  await unlinkProvider(userId(), "GOOGLE");
  assert.equal(db.rows("oAuthAccount").length, 0);
  await assert.rejects(unlinkProvider(userId(), "GOOGLE"), /not connected/);
});

test("unlinking one of two providers is allowed, the last one is not; unknown providers are refused", async () => {
  await completeOAuthLogin("GOOGLE", google);
  db.insert("oAuthAccount", { id: "oa-2", userId: userId(), provider: "FACEBOOK", providerAccountId: fb.providerAccountId });
  await unlinkProvider(userId(), "FACEBOOK");
  assert.deepEqual(db.rows("oAuthAccount").map((a) => a.provider), ["GOOGLE"]);
  await assert.rejects(unlinkProvider(userId(), "GOOGLE"), /only way to sign in/);
  await assert.rejects(unlinkProvider(userId(), "GITHUB"), /Unknown provider/);
});

test("admin accounts cannot use the unlink path", async () => {
  db.insert("user", { id: "adm", name: "A", email: "a@x.com", role: "ADMIN", passwordHash: "h", isActive: true });
  await assert.rejects(unlinkProvider("adm", "GOOGLE"), /password only/);
});

test("linking a second provider to a signed-in customer adds it without touching email/password/verification", async () => {
  await completeOAuthLogin("GOOGLE", google);
  await setInitialPassword(userId(), "hash-1");
  const before = { ...db.rows("user")[0] };
  const r = await linkProviderToUser(userId(), "FACEBOOK", { providerAccountId: "fb-9", email: "other@x.com", emailVerified: true, name: "Jo" });
  assert.equal(r.status, "linked");
  assert.deepEqual(db.rows("oAuthAccount").map((a) => a.provider).sort(), ["FACEBOOK", "GOOGLE"]);
  const after = db.rows("user")[0];
  assert.deepEqual([after.email, after.passwordHash, after.emailVerified], [before.email, before.passwordHash, before.emailVerified]);
});

test("collision protection: an identity linked to another customer is never moved; one identity per provider", async () => {
  await completeOAuthLogin("GOOGLE", google);
  db.insert("user", { id: "u2", name: "Ann", email: "ann@x.com", role: "CUSTOMER", passwordHash: "h", isActive: true });
  // u2 tries to attach Jo's Google identity
  assert.deepEqual(await linkProviderToUser("u2", "GOOGLE", { ...google, email: "ann@x.com" }), { status: "refused", reason: "taken" });
  assert.equal(db.rows("oAuthAccount").length, 1);
  assert.equal(db.rows("oAuthAccount")[0].userId, userId());
  // Jo already has a Google link; a different Google identity is refused
  assert.deepEqual(await linkProviderToUser(userId(), "GOOGLE", { providerAccountId: "g-2", email: "x@x.com", emailVerified: true, name: "J" }), { status: "refused", reason: "already_linked" });
});

test("admins, inactive and unknown users cannot link a provider", async () => {
  db.insert("user", { id: "adm", name: "A", email: "a@x.com", role: "ADMIN", passwordHash: "h", isActive: true });
  db.insert("user", { id: "off", name: "O", email: "o@x.com", role: "CUSTOMER", passwordHash: "h", isActive: false });
  for (const id of ["adm", "off", "ghost"]) {
    assert.deepEqual(await linkProviderToUser(id, "FACEBOOK", fb), { status: "refused", reason: "not_allowed" });
  }
  assert.equal(db.rows("oAuthAccount").length, 0);
});
