/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from "node:async_hooks";

// One shared ALS (stored on globalThis so test helpers and this stub agree),
// so two "requests" can run concurrently as different users.
const als: AsyncLocalStorage<{ session: any; admin: boolean }> =
  ((globalThis as any).__TEST_ALS__ ??= new AsyncLocalStorage());

export async function getSession() {
  return als.getStore()?.session ?? null;
}
export async function requireAdmin() {
  if (!als.getStore()?.admin) throw new Error("FORBIDDEN");
  return { id: "admin-1" };
}
export async function getCurrentAdmin() {
  return als.getStore()?.admin ? { id: "admin-1" } : null;
}
/** Mirrors the real helper's contract: a signed-in customer or staff member, otherwise it refuses. */
export async function requireUser() {
  const s = als.getStore()?.session;
  if (!s?.sub) throw new Error("UNAUTHENTICATED");
  return { id: s.sub, role: "CUSTOMER" };
}
