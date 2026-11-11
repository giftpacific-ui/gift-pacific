import "server-only";
import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type SlugEntity = "PRODUCT" | "CATEGORY";

/**
 * Remember a retired slug. Called inside the same transaction as the slug change. The row points at the ENTITY, so the
 * redirect always lands on whatever the current slug is (A→B→C needs no chain walking and can never loop).
 */
export async function recordSlugChange(tx: Prisma.TransactionClient, type: SlugEntity, entityId: string, oldSlug: string | null | undefined, newSlug: string) {
  // The new slug is live now, so it must not also exist as a redirect source.
  await tx.slugRedirect.deleteMany({ where: { entityType: type, oldSlug: newSlug } });
  if (!oldSlug || oldSlug === newSlug) return;
  await tx.slugRedirect.upsert({
    where: { entityType_oldSlug: { entityType: type, oldSlug } },
    create: { entityType: type, oldSlug, entityId },
    update: { entityId },
  });
}

/** A brand-new entity claims its slug: any stale redirect from that slug is dropped. */
export async function claimSlug(tx: Prisma.TransactionClient, type: SlugEntity, slug: string) {
  await tx.slugRedirect.deleteMany({ where: { entityType: type, oldSlug: slug } });
}

/** Deleting an entity removes its redirects: those URLs become a normal 404 instead of pointing at nothing. */
export async function dropSlugRedirects(tx: Prisma.TransactionClient, type: SlugEntity, entityId: string) {
  await tx.slugRedirect.deleteMany({ where: { entityType: type, entityId } });
}

/** Current public slug for a retired product slug, or null (unknown, unpublished, hidden box product, or same slug). */
export const resolveProductRedirect = cache(async (slug: string): Promise<string | null> => {
  const row = await prisma.slugRedirect.findUnique({ where: { entityType_oldSlug: { entityType: "PRODUCT", oldSlug: slug } }, select: { entityId: true } });
  if (!row) return null;
  const product = await prisma.product.findFirst({ where: { id: row.entityId, status: "ACTIVE", isBoxProduct: false }, select: { slug: true } });
  return product && product.slug !== slug ? product.slug : null;
});

export const resolveCategoryRedirect = cache(async (slug: string): Promise<string | null> => {
  const row = await prisma.slugRedirect.findUnique({ where: { entityType_oldSlug: { entityType: "CATEGORY", oldSlug: slug } }, select: { entityId: true } });
  if (!row) return null;
  const category = await prisma.category.findFirst({ where: { id: row.entityId, isActive: true }, select: { slug: true } });
  return category && category.slug !== slug ? category.slug : null;
});
