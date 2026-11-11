import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

/** Allowed "no activity for" periods (hours). Anything else falls back to the default. */
export const ABANDONED_PERIODS = [1, 6, 24, 72, 168] as const;
export const DEFAULT_ABANDONED_HOURS = 24;
/** Carts idle longer than this are stale leftovers, not recoverable abandonment. */
const MAX_AGE_DAYS = 30;

export function parseAbandonedHours(value: unknown): number {
  const n = Number(value);
  return (ABANDONED_PERIODS as readonly number[]).includes(n) ? n : DEFAULT_ABANDONED_HOURS;
}

export type AbandonedCart = {
  id: string;
  customer: { name: string; email: string } | null; // null = guest (no identity is known or stored)
  lastActivity: Date;
  itemCount: number;
  items: { name: string; variant: string | null; quantity: number; unavailable: boolean }[];
};

type CandidateRow = { id: string; lastActivity: Date };

/**
 * One definition of "abandoned", evaluated entirely in the database (parameterized):
 *  - last activity = the newest CartItem.updatedAt of the cart (item adds/edits do NOT touch Cart.updatedAt, so the
 *    cart's own timestamp is never used);
 *  - the cart has items (a completed checkout empties it, so it never appears here);
 *  - last activity is older than the inactivity period but not older than the stale limit;
 *  - a signed-in customer with an order placed at/after that last activity is converted, not abandoned.
 * Guest carts (no user) are included: no order can be linked to them, and no identity is stored.
 */
function abandonedCte(cutoff: Date, oldest: Date) {
  return Prisma.sql`
    WITH activity AS (
      SELECT c."id" AS "id", c."userId" AS "userId", MAX(ci."updatedAt") AS "lastActivity"
      FROM "Cart" c
      JOIN "CartItem" ci ON ci."cartId" = c."id"
      GROUP BY c."id", c."userId"
      HAVING MAX(ci."updatedAt") < ${cutoff} AND MAX(ci."updatedAt") >= ${oldest}
    ),
    abandoned AS (
      SELECT a."id", a."lastActivity"
      FROM activity a
      WHERE NOT (
        a."userId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "Order" o WHERE o."userId" = a."userId" AND o."createdAt" >= a."lastActivity")
      )
    )`;
}

/**
 * Read-only list of abandoned carts for an admin. Total, page count and pages all come from the SAME qualifying set,
 * so converted carts never leave a page short or empty, and only one page of rows is ever loaded.
 * Nothing is sent to anyone.
 */
export async function listAbandonedCarts(hours: number, page = 1, pageSize = 20) {
  const now = Date.now();
  const cutoff = new Date(now - hours * 3600_000);
  const oldest = new Date(now - MAX_AGE_DAYS * 86_400_000);
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const cte = abandonedCte(cutoff, oldest);

  const [countRows, pageRows] = await Promise.all([
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`${cte} SELECT COUNT(*)::int AS "total" FROM abandoned`),
    prisma.$queryRaw<CandidateRow[]>(
      Prisma.sql`${cte}
        SELECT "id", "lastActivity" FROM abandoned
        ORDER BY "lastActivity" DESC, "id" ASC
        LIMIT ${pageSize} OFFSET ${(safePage - 1) * pageSize}`,
    ),
  ]);
  const total = countRows[0]?.total ?? 0;
  if (pageRows.length === 0) return { carts: [] as AbandonedCart[], total, page: safePage, pageCount: Math.ceil(total / pageSize) };

  // Details for just this page's carts (at most `pageSize` rows).
  const details = await prisma.cart.findMany({
    where: { id: { in: pageRows.map((r) => r.id) } },
    select: {
      id: true,
      user: { select: { name: true, email: true } },
      items: { select: { quantity: true, product: { select: { name: true, status: true } }, variant: { select: { name: true } } } },
    },
  });
  const byId = new Map(details.map((d) => [d.id, d]));

  const carts: AbandonedCart[] = [];
  for (const row of pageRows) {
    const cart = byId.get(row.id);
    if (!cart) continue; // removed between the two reads
    carts.push({
      id: cart.id,
      customer: cart.user ? { name: cart.user.name, email: cart.user.email } : null,
      lastActivity: row.lastActivity,
      itemCount: cart.items.reduce((sum, i) => sum + i.quantity, 0),
      items: cart.items.map((i) => ({ name: i.product.name, variant: i.variant?.name ?? null, quantity: i.quantity, unavailable: i.product.status !== "ACTIVE" })),
    });
  }
  return { carts, total, page: safePage, pageCount: Math.ceil(total / pageSize) };
}
