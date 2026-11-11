/* eslint-disable @typescript-eslint/no-explicit-any */
// Delegates to whichever FakeDb the current test installed. Functions are
// bound to the db so `this` (transaction lock, snapshot, sequence) is the
// real FakeDb — not this proxy.
export const prisma: any = new Proxy(
  {},
  {
    get: (_t, key) => {
      const db = (globalThis as any).__TEST_DB__;
      const value = db[key as string];
      return typeof value === "function" ? value.bind(db) : value;
    },
  },
);
