"use server";

import { toUserMessage } from "@/lib/errors";
import { normalizeKeywords } from "@/lib/seo-keywords";
import { parseScheduleWindow } from "@/lib/schedule";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import {
  storeSettingsFormSchema,
  bannerFormSchema,
} from "@/lib/validations/admin";
import {
  updateStoreSettings,
  getStoreSettings,
} from "@/server/services/admin-settings.service";
import {
  adminCreateBanner,
  adminUpdateBanner,
  adminDeleteBanner,
  adminGetBannerById,
} from "@/server/services/admin-banner.service";
import { deleteImageFromCloudinary } from "@/lib/cloudinary/cloudinary";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

function toNullableNumber(value: number | "" | undefined): number | null {
  return value === "" || value === undefined ? null : value;
}

export async function saveStoreSettingsAction(
  raw: Record<string, unknown>,
): Promise<AdminActionResult> {
  await requireAdmin();

  const parsed = storeSettingsFormSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  const previous = await getStoreSettings();

  await updateStoreSettings({
    storeName: parsed.data.storeName,
    storeEmail: parsed.data.storeEmail || undefined,
    storePhone: parsed.data.storePhone || undefined,
    storeAddress: parsed.data.storeAddress || undefined,
    // empty string বা undefined হ্যান্ডেল করার জন্য সঠিক ভ্যালু এসাইন
    logoUrl: parsed.data.logoUrl || "",
    logoCloudinaryPublicId: parsed.data.logoCloudinaryPublicId || null,
    faviconUrl: parsed.data.faviconUrl || "",
    faviconCloudinaryPublicId: parsed.data.faviconCloudinaryPublicId || null,
    primaryColor: parsed.data.primaryColor,
    secondaryColor: parsed.data.secondaryColor,
    currencyCode: parsed.data.currencyCode,
    currencySymbol: parsed.data.currencySymbol,
    instagramUrl: parsed.data.instagramUrl || undefined,
    facebookUrl: parsed.data.facebookUrl || undefined,
    whatsappUrl: parsed.data.whatsappUrl || undefined,
    tiktokUrl: parsed.data.tiktokUrl || undefined,
    deliveryChargeDhaka: parsed.data.deliveryChargeDhaka,
    deliveryChargeOutsideDhaka: parsed.data.deliveryChargeOutsideDhaka,
    deliveryChargeOther: parsed.data.deliveryChargeOther,
    shippingFlatRate: parsed.data.shippingFlatRate ?? 0,
    freeShippingThreshold: toNullableNumber(parsed.data.freeShippingThreshold),
    taxRatePercent: parsed.data.taxRatePercent,
    // null (not undefined) so an admin can actually CLEAR a tracking id
    gtmId: parsed.data.gtmId || null,
    metaPixelId: parsed.data.metaPixelId || null,
    tiktokPixelId: parsed.data.tiktokPixelId || null,
    linkedinPartnerId: parsed.data.linkedinPartnerId || null,
    consentMode: parsed.data.consentMode,
    seoTitleTemplate: parsed.data.seoTitleTemplate || null,
    seoDescription: parsed.data.seoDescription || null,
    seoKeywords: normalizeKeywords(parsed.data.seoKeywords),
    ogImageUrl: parsed.data.ogImageUrl || null,
  });

  // Logo was replaced — clean up the old Cloudinary asset
  if (
    previous?.logoCloudinaryPublicId &&
    previous.logoCloudinaryPublicId !== parsed.data.logoCloudinaryPublicId
  ) {
    await deleteImageFromCloudinary(previous.logoCloudinaryPublicId);
  }
  // Favicon was replaced — same cleanup
  if (
    previous?.faviconCloudinaryPublicId &&
    previous.faviconCloudinaryPublicId !== parsed.data.faviconCloudinaryPublicId
  ) {
    await deleteImageFromCloudinary(previous.faviconCloudinaryPublicId);
  }

  revalidatePath("/admin/settings");
  revalidatePath("/", "layout"); // পুরো লেআউট রিভ্যালিডেট করবে যেন নেভবার সাথে সাথে আপডেট হয়
  return { success: true };
}

export async function saveBannerAction(
  bannerId: string | null,
  raw: Record<string, unknown>,
): Promise<AdminActionResult> {
  await requireAdmin();
  const parsed = bannerFormSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  const schedule = parseScheduleWindow(parsed.data.startsAt, parsed.data.endsAt);
  if (!schedule.ok) return { success: false, message: schedule.message };
  const scheduleFields = { startsAt: schedule.startsAt, endsAt: schedule.endsAt };

  const data = {
    title: parsed.data.title,
    subtitle: parsed.data.subtitle || undefined,
    imageUrl: parsed.data.imageUrl,
    cloudinaryPublicId: parsed.data.cloudinaryPublicId || null,
    ctaLabel: parsed.data.ctaLabel || undefined,
    // A campaign banner always leads to /campaign (it never embeds products).
    ctaHref: parsed.data.placement === "CAMPAIGN" ? "/campaign" : parsed.data.ctaHref || undefined,
    placement: parsed.data.placement,
    sortOrder: parsed.data.sortOrder,
    isActive: parsed.data.isActive,
    ...scheduleFields,
  };

  let previousPublicId: string | null = null;
  if (bannerId) {
    const existing = await adminGetBannerById(bannerId);
    previousPublicId = existing?.cloudinaryPublicId ?? null;
  }

  const banner = bannerId
    ? await adminUpdateBanner(bannerId, data)
    : await adminCreateBanner(data);

  if (previousPublicId && previousPublicId !== data.cloudinaryPublicId) {
    await deleteImageFromCloudinary(previousPublicId);
  }

  revalidatePath("/admin/banners");
  revalidatePath("/", "layout");
  return { success: true, id: banner.id };
}

export async function deleteBannerAction(
  bannerId: string,
): Promise<AdminActionResult> {
  await requireAdmin();
  try {
    const banner = await adminGetBannerById(bannerId);
    await adminDeleteBanner(bannerId);
    // The row is already gone: a failed image cleanup must not turn a successful delete into an error.
    if (banner?.cloudinaryPublicId) await deleteImageFromCloudinary(banner.cloudinaryPublicId).catch(() => undefined);
    revalidatePath("/admin/banners");
    revalidatePath("/", "layout");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not delete the banner.") };
  }
}
