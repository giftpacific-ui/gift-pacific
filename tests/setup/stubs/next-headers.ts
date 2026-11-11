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
