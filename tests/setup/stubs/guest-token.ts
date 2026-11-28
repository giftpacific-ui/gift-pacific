/* eslint-disable @typescript-eslint/no-explicit-any */
// A test chooses the visitor's guest cart cookie with `runAs(who, fn, { guest: "token" })` (tests/setup/helpers). One value per simulated browser, safe under concurrency (AsyncLocalStorage).
// Not chosen: getOrCreate keeps its old fixed token and peek reports "no cookie" (what every earlier test relies on).
const tokenOf = (): string | null => (globalThis as any).__TEST_ALS__?.getStore()?.guest ?? null;
export async function getOrCreateGuestToken() {
  return tokenOf() ?? "guest-token-1";
}
export async function peekGuestToken() {
  return tokenOf();
}
export async function clearGuestToken() {}
