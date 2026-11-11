import "server-only";
import { prisma } from "@/lib/db/prisma";
import { claimSlug, dropSlugRedirects, recordSlugChange } from "@/server/services/slug-redirect.service";

export async function adminListCategories() {
  const categories = await prisma.category.findMany({
    orderBy: { sortOrder: "asc" },
    include: { _count: { select: { products: true } } },
  });

  // Order as a tree (parent immediately followed by its children) rather
  // than flat sortOrder, and annotate each with its depth for indentation.
  const byParent = new Map<string | null, typeof categories>();
  for (const category of categories) {
    const key = category.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(category);
  }

  const ordered: ((typeof categories)[number] & { depth: number })[] = [];
  function walk(parentId: string | null, depth: number) {
    for (const category of byParent.get(parentId) ?? []) {
      ordered.push({ ...category, depth });
      walk(category.id, depth + 1);
    }
  }
  walk(null, 0);
  return ordered;
}

export type CategoryInput = {
  name: string;
  slug: string;
  description?: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  metaKeywords?: string[];
  seoNoIndex?: boolean;
  image?: string;
  imageCloudinaryPublicId?: string | null;
  parentId?: string | null;
  isFeatured: boolean;
  isActive: boolean;
  sortOrder: number;
};

/** Builds a flat, indented list of categories representing the tree — used for admin select dropdowns. */
export async function adminListCategoriesForSelect() {
  const categories = await prisma.category.findMany({ orderBy: { sortOrder: "asc" } });
  const byParent = new Map<string | null, typeof categories>();
  for (const category of categories) {
    const key = category.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(category);
  }

  const result: { id: string; name: string; depth: number }[] = [];
  function walk(parentId: string | null, depth: number) {
    for (const category of byParent.get(parentId) ?? []) {
      result.push({ id: category.id, name: category.name, depth });
      walk(category.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}

export async function adminGetCategoryById(id: string) {
  return prisma.category.findUnique({ where: { id } });
}

export async function adminCreateCategory(input: CategoryInput) {
  return prisma.$transaction(async (tx) => {
    const category = await tx.category.create({ data: input });
    await claimSlug(tx, "CATEGORY", category.slug);
    return category;
  });
}

export async function adminUpdateCategory(id: string, input: CategoryInput) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.category.findUnique({ where: { id }, select: { slug: true } });
    const updated = await tx.category.update({ where: { id }, data: input });
    await recordSlugChange(tx, "CATEGORY", id, current?.slug, updated.slug);
    return updated;
  });
}

export async function adminDeleteCategory(id: string) {
  return prisma.$transaction(async (tx) => {
    await dropSlugRedirects(tx, "CATEGORY", id);
    return tx.category.delete({ where: { id } });
  });
}
