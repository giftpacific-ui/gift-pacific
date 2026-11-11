"use server";

import { normalizeKeywords } from "@/lib/seo-keywords";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { categoryFormSchema } from "@/lib/validations/admin";
import {
  adminCreateCategory,
  adminUpdateCategory,
  adminDeleteCategory,
  adminListCategoriesForSelect,
  adminGetCategoryById,
} from "@/server/services/admin-category.service";
import { deleteImageFromCloudinary } from "@/lib/cloudinary/cloudinary";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

export async function getCategoriesForSelectAction() {
  await requireAdmin();
  return adminListCategoriesForSelect();
}

export async function saveCategoryAction(
  categoryId: string | null,
  raw: Record<string, unknown>,
): Promise<AdminActionResult> {
  await requireAdmin();
  const parsed = categoryFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const data = {
    name: parsed.data.name,
    slug: parsed.data.slug,
    description: parsed.data.description || undefined,
    // Always written (null/[] clears) so emptying a field in the form really removes it.
    metaTitle: parsed.data.metaTitle || null,
    metaDescription: parsed.data.metaDescription || null,
    metaKeywords: normalizeKeywords(parsed.data.metaKeywords),
    seoNoIndex: parsed.data.seoNoIndex === true,
    image: parsed.data.image || undefined,
    imageCloudinaryPublicId: parsed.data.imageCloudinaryPublicId || null,
    parentId: parsed.data.parentId || null,
    isFeatured: parsed.data.isFeatured,
    isActive: parsed.data.isActive,
    sortOrder: parsed.data.sortOrder,
  };

  let previousPublicId: string | null = null;
  if (categoryId) {
    const existing = await adminGetCategoryById(categoryId);
    previousPublicId = existing?.imageCloudinaryPublicId ?? null;
  }

  try {
    const category = categoryId
      ? await adminUpdateCategory(categoryId, data)
      : await adminCreateCategory(data);

    if (previousPublicId && previousPublicId !== data.imageCloudinaryPublicId) {
      await deleteImageFromCloudinary(previousPublicId);
    }

    revalidatePath("/admin/categories");
    revalidatePath("/shop");
    revalidatePath("/sitemap.xml");
    return { success: true, id: category.id };
  } catch {
    return { success: false, message: "Could not save category — the slug may already be in use." };
  }
}

export async function deleteCategoryAction(categoryId: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    const existing = await adminGetCategoryById(categoryId);
    await adminDeleteCategory(categoryId);
    if (existing?.imageCloudinaryPublicId) {
      await deleteImageFromCloudinary(existing.imageCloudinaryPublicId);
    }
    revalidatePath("/admin/categories");
    return { success: true };
  } catch {
    return { success: false, message: "Could not delete category — it may still have products." };
  }
}
