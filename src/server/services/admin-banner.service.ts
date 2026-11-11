import "server-only";
import { prisma } from "@/lib/db/prisma";
import type { BannerPlacement } from "@prisma/client";

export async function adminListBanners() {
  return prisma.banner.findMany({ orderBy: [{ placement: "asc" }, { sortOrder: "asc" }] });
}

export async function adminGetBannerById(id: string) {
  return prisma.banner.findUnique({ where: { id } });
}

export type BannerInput = {
  title: string;
  subtitle?: string;
  imageUrl: string;
  cloudinaryPublicId?: string | null;
  ctaLabel?: string;
  ctaHref?: string;
  placement: BannerPlacement;
  sortOrder: number;
  isActive: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
};

export async function adminCreateBanner(input: BannerInput) {
  return prisma.banner.create({ data: input });
}

export async function adminUpdateBanner(id: string, input: BannerInput) {
  return prisma.banner.update({ where: { id }, data: input });
}

export async function adminDeleteBanner(id: string) {
  return prisma.banner.delete({ where: { id } });
}
