/* eslint-disable @typescript-eslint/no-explicit-any */
// In-memory cookie jar standing in for next/headers `cookies()`.
const jar: Map<string, { value: string; options: any }> = ((globalThis as any).__TEST_COOKIES__ ??= new Map());

export async function cookies() {
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: any) => void jar.set(name, { value, options }),
    delete: (name: string) => void jar.delete(name),
  };
}

// Request headers stand-in: tests set `globalThis.__TEST_HEADERS__ = { "user-agent": "...", "x-forwarded-for": "..." }`.
export async function headers() {
  const map = ((globalThis as any).__TEST_HEADERS__ ??= {}) as Record<string, string>;
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}
