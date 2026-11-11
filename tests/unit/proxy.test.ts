import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-test-secret-test-secret-123456";
const { proxy } = await import("../../src/proxy");
const { createSessionToken, sessionCookieConfig, adminSessionCookieConfig } = await import("../../src/lib/auth/session");

// Route gating decisions made BEFORE any page renders (cookie shape only; page-level checks confirm the user still exists —
// see src/app/admin/(dashboard)/layout.tsx and src/app/account/layout.tsx).
const req = (path: string, cookies: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
const tok = (role: "ADMIN" | "CUSTOMER") => createSessionToken({ sub: "u1", role, email: "a@x.test", name: "A" });
const where = (res: Response) => { const l = res.headers.get("location"); return l ? new URL(l).pathname + new URL(l).search : null; };

test("logged-out visitor: /admin and admin subpages go to /admin/login (with the intended path)", async () => {
  assert.equal(where(await proxy(req("/admin"))), "/admin/login?redirect=%2Fadmin");
  assert.equal(where(await proxy(req("/admin/orders"))), "/admin/login?redirect=%2Fadmin%2Forders");
});

test("the admin login page itself is always reachable by the proxy (no redirect loop); page code redirects signed-in admins", async () => {
  assert.equal((await proxy(req("/admin/login"))).headers.get("location"), null);
  assert.equal((await proxy(req("/admin/login", { [adminSessionCookieConfig.name]: await tok("ADMIN") }))).headers.get("location"), null);
});

test("valid admin session reaches /admin; a customer token in the ADMIN cookie is bounced to the storefront", async () => {
  assert.equal((await proxy(req("/admin", { [adminSessionCookieConfig.name]: await tok("ADMIN") }))).headers.get("location"), null);
  assert.equal(where(await proxy(req("/admin", { [adminSessionCookieConfig.name]: await tok("CUSTOMER") }))), "/");
});

test("a customer session cookie never opens /admin, and an admin cookie never opens /account", async () => {
  assert.equal(where(await proxy(req("/admin", { [sessionCookieConfig.name]: await tok("CUSTOMER") }))), "/admin/login?redirect=%2Fadmin");
  assert.equal(where(await proxy(req("/account", { [adminSessionCookieConfig.name]: await tok("ADMIN") }))), "/login?redirect=%2Faccount");
});

test("logged-out visitor to a protected customer page goes to /login; a valid customer cookie passes", async () => {
  assert.equal(where(await proxy(req("/account/orders"))), "/login?redirect=%2Faccount%2Forders");
  assert.equal((await proxy(req("/account/orders", { [sessionCookieConfig.name]: await tok("CUSTOMER") }))).headers.get("location"), null);
});

test("expired / garbage tokens behave like no session (no error page, no loop)", async () => {
  assert.equal(where(await proxy(req("/admin", { [adminSessionCookieConfig.name]: "not-a-jwt" }))), "/admin/login?redirect=%2Fadmin");
  assert.equal(where(await proxy(req("/account", { [sessionCookieConfig.name]: "x.y.z" }))), "/login?redirect=%2Faccount");
});
