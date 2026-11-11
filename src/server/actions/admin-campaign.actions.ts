"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { parseScheduleWindow } from "@/lib/schedule";
import {
  adminAddCampaignProduct,
  adminDeleteCampaign,
  adminRemoveCampaignProduct,
  adminSaveCampaign,
  adminSearchProductsForCampaign,
} from "@/server/services/admin-campaign.service";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

function refresh() {
  revalidatePath("/admin/campaigns");
  revalidatePath("/campaign");
  revalidatePath("/");
}

export async function saveCampaignAction(
  campaignId: string | null,
  raw: {
    name: string;
    slug: string;
    description?: string;
    image?: string;
    metaTitle?: string;
    metaDescription?: string;
    isActive: boolean;
    startsAt?: string;
    endsAt?: string;
  },
): Promise<AdminActionResult> {
  await requireAdmin();
  const window = parseScheduleWindow(raw.startsAt, raw.endsAt);
  if (!window.ok) return { success: false, message: window.message };
  const metaTitle = raw.metaTitle?.trim() || null;
  const metaDescription = raw.metaDescription?.trim() || null;
  if ((metaTitle?.length ?? 0) > 120) return { success: false, message: "SEO title can be at most 120 characters." };
  if ((metaDescription?.length ?? 0) > 300) return { success: false, message: "SEO description can be at most 300 characters." };
  try {
    await adminSaveCampaign(campaignId, {
      name: String(raw.name ?? ""),
      slug: String(raw.slug ?? "").trim().toLowerCase(),
      description: raw.description?.trim() || null,
      image: raw.image?.trim() || null,
      metaTitle,
      metaDescription,
      isActive: raw.isActive === true,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
    });
    refresh();
    return { success: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return { success: false, message: "That slug is already used." };
    }
    return { success: false, message: toUserMessage(error, "Could not save the campaign.") };
  }
}

export async function deleteCampaignAction(campaignId: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminDeleteCampaign(campaignId);
    refresh();
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not delete the campaign.") };
  }
}

export async function addCampaignProductAction(campaignId: string, productId: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminAddCampaignProduct(campaignId, productId);
    refresh();
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not add the product.") };
  }
}

export async function removeCampaignProductAction(campaignId: string, productId: string): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    await adminRemoveCampaignProduct(campaignId, productId);
    refresh();
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not remove the product.") };
  }
}

export async function searchProductsForCampaignAction(search: string) {
  await requireAdmin();
  if (typeof search !== "string" || !search.trim()) return [];
  return adminSearchProductsForCampaign(search.trim().slice(0, 100));
}
