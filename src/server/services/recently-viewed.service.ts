import "server-only";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/current-user";
import { getProductsByIds } from "@/server/services/product.service";
import type { PublicProductCard } from "@/lib/product-dto";

export const RECENTLY_VIEWED_MAX = 20;
/** A product seen again within this window does not cause another write. */
const REWRITE_AFTER_MS = 10 * 60 * 1000;

/**
 * Records a view for the signed-in customer. Only ACTIVE, publicly sold products are recorded (never drafts, archived
 * items or a box's hidden backing product), so admin previews of unpublished products leave no trace. One row per
 * (customer, product): seeing it again moves it to the top, and anything beyond the newest 20 is dropped.
 */
export async function recordProductView(productId: string): Promise<boolean> {
  const session = await getSession();
  if (!session || typeof productId !== "string" || !productId) return false;
  // Admin sessions are not customers: previews must not create customer history.
  if (session.role !== "CUSTOMER") return false;

  const product = await prisma.product.findFirst({ where: { id: productId, status: "ACTIVE", isBoxProduct: false }, select: { id: true } });
  if (!product) return false;

  const existing = await prisma.recentlyViewedProduct.findUnique({
    where: { userId_productId: { userId: session.sub, productId } },
    select: { viewedAt: true },
  });
  if (existing && Date.now() - existing.viewedAt.getTime() < REWRITE_AFTER_MS) return true;

  await prisma.$transaction(async (tx) => {
    await tx.recentlyViewedProduct.upsert({
      where: { userId_productId: { userId: session.sub, productId } },
      update: { viewedAt: new Date() },
      create: { userId: session.sub, productId },
    });
    const stale = await tx.recentlyViewedProduct.findMany({
      where: { userId: session.sub },
      orderBy: { viewedAt: "desc" },
      skip: RECENTLY_VIEWED_MAX,
      select: { id: true },
    });
    if (stale.length > 0) await tx.recentlyViewedProduct.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  });
  return true;
}

/** The customer's recently viewed products as PUBLIC cards (inactive/deleted products simply drop out), newest first. */
export async function getMyRecentlyViewed(limit = 8, excludeProductId?: string): Promise<PublicProductCard[]> {
  const session = await getSession();
  if (!session) return [];
  const rows = await prisma.recentlyViewedProduct.findMany({
    where: { userId: session.sub, ...(excludeProductId ? { productId: { not: excludeProductId } } : {}), product: { status: "ACTIVE", isBoxProduct: false } },
    orderBy: { viewedAt: "desc" },
    take: Math.min(Math.max(limit, 1), RECENTLY_VIEWED_MAX),
    select: { productId: true },
  });
  return getProductsByIds(rows.map((r) => r.productId));
}
