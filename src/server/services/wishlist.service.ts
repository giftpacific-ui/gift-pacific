import "server-only";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/current-user";
import type { Prisma } from "@prisma/client";
import { toPublicProductCard, type PublicProductCard } from "@/lib/product-dto";
import { UserFacingError } from "@/lib/errors";

const wishlistProductSelect = {
  id: true,
  name: true,
  slug: true,
  shortDescription: true,
  type: true,
  badges: true,
  currency: true,
  price: true,
  compareAtPrice: true,
  videoUrl: true,
  // Only used to compute availability in the mapper; never output.
  stock: true,
  allowBackorder: true,
  trackInventory: true,
  images: { select: { url: true, altText: true }, orderBy: { sortOrder: "asc" as const }, take: 2 },
  category: { select: { name: true, slug: true } },
  variants: { select: { price: true, stock: true, allowBackorder: true } },
} satisfies Prisma.ProductSelect;

export async function getWishlistProductIds(): Promise<string[]> {
  const session = await getSession();
  if (!session) return [];

  const wishlist = await prisma.wishlist.findUnique({
    where: { userId: session.sub },
    include: { items: { select: { productId: true } } },
  });
  return wishlist?.items.map((item) => item.productId) ?? [];
}

/**
 * Wishlist products as PUBLIC card DTOs (no costPrice, no raw stock, no
 * variant rows) — they are handed to a client component.
 */
export async function getWishlistWithProducts(): Promise<PublicProductCard[]> {
  const session = await getSession();
  if (!session) return [];

  const wishlist = await prisma.wishlist.findUnique({
    where: { userId: session.sub },
    select: {
      items: {
        where: { product: { status: "ACTIVE" } },
        select: { product: { select: wishlistProductSelect } },
        orderBy: { addedAt: "desc" },
      },
    },
  });
  return (wishlist?.items ?? []).map((item) => toPublicProductCard(item.product));
}

/**
 * Everything the customer saved, split by whether it can still be bought. Products that were unpublished are kept
 * visible (name only, no link, no price) so the customer can remove them; deleted products are already gone from the list.
 */
export async function getWishlistEntries(): Promise<{ available: PublicProductCard[]; unavailable: { productId: string; name: string }[] }> {
  const session = await getSession();
  if (!session) return { available: [], unavailable: [] };
  const wishlist = await prisma.wishlist.findUnique({
    where: { userId: session.sub },
    select: {
      items: {
        select: { product: { select: { ...wishlistProductSelect, status: true } } },
        orderBy: { addedAt: "desc" },
      },
    },
  });
  const available: PublicProductCard[] = [];
  const unavailable: { productId: string; name: string }[] = [];
  for (const item of wishlist?.items ?? []) {
    const { status, ...product } = item.product;
    if (status === "ACTIVE") available.push(toPublicProductCard(product as Parameters<typeof toPublicProductCard>[0]));
    else unavailable.push({ productId: item.product.id, name: item.product.name });
  }
  return { available, unavailable };
}

export async function toggleWishlistItem(productId: string): Promise<{ inWishlist: boolean }> {
  const session = await getSession();
  if (!session) throw new Error("UNAUTHENTICATED");

  const wishlist = await prisma.wishlist.upsert({
    where: { userId: session.sub },
    update: {},
    create: { userId: session.sub },
  });

  const existing = await prisma.wishlistItem.findUnique({
    where: { wishlistId_productId: { wishlistId: wishlist.id, productId } },
  });

  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });
    return { inWishlist: false };
  }

  const product = await prisma.product.findFirst({
    where: { id: productId, status: "ACTIVE" },
    select: { id: true },
  });
  if (!product) throw new UserFacingError("This product is not available.");

  try {
    await prisma.wishlistItem.create({ data: { wishlistId: wishlist.id, productId } });
  } catch (error) {
    // Two taps/tabs at once: the unique (wishlist, product) index lets one through. The item IS on the list, which is what was asked.
    if ((error as { code?: string }).code !== "P2002") throw error;
  }
  return { inWishlist: true };
}

export async function removeWishlistItem(productId: string) {
  const session = await getSession();
  if (!session) throw new Error("UNAUTHENTICATED");
  const wishlist = await prisma.wishlist.findUnique({ where: { userId: session.sub } });
  if (!wishlist) return;
  await prisma.wishlistItem.deleteMany({ where: { wishlistId: wishlist.id, productId } });
}
