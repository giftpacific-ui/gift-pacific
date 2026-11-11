import { Prisma } from "@prisma/client";

/**
 * Recursively converts any Prisma `Decimal` values in `value` into plain
 * numbers, so the result is safe to pass from a Server Component (or a
 * Server Action's return value) into a Client Component.
 *
 * React Server Components can already serialize plain objects, arrays,
 * strings, numbers, booleans, and Dates across that boundary — `Decimal`
 * (a class instance from decimal.js, not a plain object) is the one Prisma
 * return type that can't cross as-is and throws "Only plain objects can be
 * passed to Client Components from Server Components. Decimal objects are
 * not supported."
 *
 * This mirrors how the rest of the app already treats money values —
 * `Number(price)` is the existing convention everywhere (cart, invoices,
 * product cards) — so converting to `number` here (rather than a string)
 * is consistent, not a new precision decision. These are small BDT amounts
 * with at most 2 decimal places, well within float precision for display
 * and arithmetic; nothing here changes how prices are computed or stored —
 * only how already-computed Decimal values cross the RSC boundary.
 *
 * Use this once, at the point where server-fetched data is handed to a
 * `"use client"` component — not scattered through every leaf component.
 */
export function serializeDecimals<T>(value: T): T {
  if (value === null || value === undefined) return value;

  if (value instanceof Prisma.Decimal) {
    return Number(value) as unknown as T;
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeDecimals(item)) as unknown as T;
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = serializeDecimals(val);
    }
    return result as T;
  }

  return value;
}
