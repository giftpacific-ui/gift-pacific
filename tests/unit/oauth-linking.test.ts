import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLinking, type LinkingInput } from "@/lib/oauth/linking";

const base = (over: Partial<LinkingInput> = {}): LinkingInput => ({
  linkedUser: null, emailUser: null, profile: { email: "a@x.com", emailVerified: true }, ...over,
});
const cust = (o = {}) => ({ id: "u1", role: "CUSTOMER", isActive: true, ...o });
const local = (o = {}) => ({ ...cust(), hasPassword: true, ...o });

test("already linked provider account signs straight in", () => {
  assert.deepEqual(decideLinking(base({ linkedUser: cust() })), { type: "login", userId: "u1" });
});

test("linked but deactivated or non-customer is refused", () => {
  assert.deepEqual(decideLinking(base({ linkedUser: cust({ isActive: false }) })), { type: "refuse", reason: "inactive" });
  assert.deepEqual(decideLinking(base({ linkedUser: cust({ role: "ADMIN" }) })), { type: "refuse", reason: "admin_email" });
});

test("no email from the provider: nothing is created or linked", () => {
  assert.deepEqual(decideLinking(base({ profile: { email: null, emailVerified: false } })), { type: "refuse", reason: "no_email" });
  assert.deepEqual(decideLinking(base({ profile: { email: null, emailVerified: true }, emailUser: local() })), { type: "refuse", reason: "no_email" });
});

test("brand-new email: a customer account is created (verified or not)", () => {
  assert.deepEqual(decideLinking(base()), { type: "create" });
  assert.deepEqual(decideLinking(base({ profile: { email: "a@x.com", emailVerified: false } })), { type: "create" });
});

test("PRE-HIJACK DEFENCE: an existing account with a password is NEVER linked automatically, even for a verified Google email", () => {
  for (const emailVerified of [true, false]) {
    assert.deepEqual(decideLinking(base({ emailUser: local(), profile: { email: "a@x.com", emailVerified } })), { type: "needs_password", userId: "u1" });
  }
});

test("admins can never be created, linked or authenticated via social login", () => {
  for (const emailVerified of [true, false]) {
    assert.deepEqual(decideLinking(base({ emailUser: local({ role: "ADMIN" }), profile: { email: "a@x.com", emailVerified } })), { type: "refuse", reason: "admin_email" });
  }
  assert.deepEqual(decideLinking(base({ emailUser: local({ role: "ADMIN", hasPassword: false }) })), { type: "refuse", reason: "admin_email" });
});

test("deactivated account with the same email is refused", () => {
  assert.deepEqual(decideLinking(base({ emailUser: local({ isActive: false }) })), { type: "refuse", reason: "inactive" });
});

test("social-only account: linked automatically only when the provider vouches for the email", () => {
  const socialOnly = local({ hasPassword: false });
  assert.deepEqual(decideLinking(base({ emailUser: socialOnly })), { type: "link_login", userId: "u1" });
  assert.deepEqual(decideLinking(base({ emailUser: socialOnly, profile: { email: "a@x.com", emailVerified: false } })), { type: "refuse", reason: "use_other_method" });
});
