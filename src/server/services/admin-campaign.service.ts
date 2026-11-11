import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { validateCampaignInput } from "@/lib/campaign-rules";

export type CampaignSaveInput = {
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
};

export async function adminListCampaigns() {
  const rows = await prisma.collection.findMany({
    where: { isCampaign: true },
    orderBy: { createdAt: "desc" },
    include: { products: { include: { product: { select: { id: true, name: true, status: true } } } } },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    image: c.image,
    metaTitle: c.metaTitle,
    metaDescription: c.metaDescription,
    isActive: c.isActive,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    products: c.products.map((p) => ({ id: p.product.id, name: p.product.name, status: p.product.status })),
  }));
}

export async function adminSaveCampaign(id: string | null, input: CampaignSaveInput) {
  const problem = validateCampaignInput(input);
  if (problem) throw new UserFacingError(problem);
  const data = { ...input, name: input.name.trim() };

  if (!id) {
    return prisma.collection.create({ data: { ...data, isCampaign: true } });
  }
  // Only campaigns can be edited here (never an arbitrary collection).
  const updated = await prisma.collection.updateMany({ where: { id, isCampaign: true }, data });
  if (updated.count !== 1) throw new UserFacingError("Campaign not found.");
  return { id };
}

export async function adminDeleteCampaign(id: string) {
  const deleted = await prisma.collection.deleteMany({ where: { id, isCampaign: true } });
  if (deleted.count !== 1) throw new UserFacingError("Campaign not found.");
}

async function requireCampaign(campaignId: string) {
  const campaign = await prisma.collection.findFirst({ where: { id: campaignId, isCampaign: true }, select: { id: true } });
  if (!campaign) throw new UserFacingError("Campaign not found.");
}

/** Idempotent: adding a product that is already in the campaign is a no-op. */
export async function adminAddCampaignProduct(campaignId: string, productId: string) {
  await requireCampaign(campaignId);
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw new UserFacingError("Product not found.");
  try {
    await prisma.productCollection.create({ data: { collectionId: campaignId, productId } });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
  }
}

export async function adminRemoveCampaignProduct(campaignId: string, productId: string) {
  await requireCampaign(campaignId);
  await prisma.productCollection.deleteMany({ where: { collectionId: campaignId, productId } });
}

export async function adminSearchProductsForCampaign(search: string) {
  return prisma.product.findMany({
    where: { name: { contains: search, mode: "insensitive" } },
    select: { id: true, name: true, status: true },
    take: 10,
  });
}
