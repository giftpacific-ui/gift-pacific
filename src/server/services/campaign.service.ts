import "server-only";
import { prisma } from "@/lib/db/prisma";
import { listProducts } from "@/server/services/product.service";

/** Public view of the running campaign — explicit fields only. */
export type ActiveCampaign = {
  /** Server-side only (used to query products); not rendered or sent to clients. */
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  endsAt: Date | null;
  /** Optional SEO overrides entered in the admin (public text). */
  metaTitle: string | null;
  metaDescription: string | null;
  /** Real last-change time, used for the sitemap. */
  updatedAt: Date;
};

/**
 * The campaign shown at /campaign: an active campaign collection inside its
 * schedule window (the most recently created one if several overlap).
 */
export async function getActiveCampaign(now: Date = new Date()): Promise<ActiveCampaign | null> {
  const row = await prisma.collection.findFirst({
    where: {
      isCampaign: true,
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, description: true, image: true, endsAt: true, metaTitle: true, metaDescription: true, updatedAt: true },
  });
  return row
    ? { id: row.id, name: row.name, description: row.description, image: row.image, endsAt: row.endsAt, metaTitle: row.metaTitle, metaDescription: row.metaDescription, updatedAt: row.updatedAt }
    : null;
}

/** ACTIVE products of the campaign as public card DTOs (same privacy guarantees as the shop). */
export async function getCampaignProducts(campaignId: string, page = 1) {
  return listProducts({ collectionId: campaignId, page, pageSize: 12 });
}
