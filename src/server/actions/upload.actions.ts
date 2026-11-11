"use server";

import { requireAdmin } from "@/lib/auth/current-user";
import {
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
  isCloudinaryConfigured,
} from "@/lib/cloudinary/cloudinary";
import { logServerError } from "@/lib/logger";
import { isCloudinaryAssetReferenced } from "@/server/services/admin-product.service";
import { isAppCloudinaryPublicId, validateImageDataUrl } from "@/lib/upload-validation";

export type UploadImageResult =
  | { success: true; url: string; publicId: string }
  | { success: false; message: string };

const UPLOAD_FOLDERS = ["products", "banners", "branding", "categories", "team", "boxes"] as const;
type UploadFolder = (typeof UPLOAD_FOLDERS)[number];

/**
 * Accepts a base64 data URL from the browser (read via FileReader on the
 * client) and uploads it to Cloudinary. Used by every admin image field:
 * product thumbnail/gallery, banner image, store logo.
 *
 * Validation (see lib/upload-validation.ts): explicit MIME allow-list
 * (JPEG / PNG / WebP — SVG and everything else rejected), decoded-byte
 * signature must match the declared type, and an 8 MB cap. The request-body
 * limit in next.config.ts is sized to fit this, so the two don't contradict.
 */
export async function uploadImageAction(
  dataUrl: string,
  folder: UploadFolder,
  /** Optional readable name (e.g. the product name) used for the stored file name. */
  nameHint?: string,
): Promise<UploadImageResult> {
  await requireAdmin();

  if (!(UPLOAD_FOLDERS as readonly string[]).includes(folder)) {
    return { success: false, message: "Invalid upload destination." };
  }

  if (!isCloudinaryConfigured()) {
    return {
      success: false,
      message:
        "Image uploads aren't configured yet. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in your environment.",
    };
  }

  const validation = validateImageDataUrl(dataUrl);
  if (!validation.ok) return { success: false, message: validation.message };

  try {
    const result = await uploadImageToCloudinary(dataUrl, folder, typeof nameHint === "string" ? nameHint.slice(0, 120) : undefined);
    return { success: true, url: result.url, publicId: result.publicId };
  } catch (error) {
    logServerError("upload.cloudinary", error, { folder });
    return { success: false, message: "Upload failed. Please try again." };
  }
}

export async function deleteCloudinaryImageAction(publicId: string) {
  await requireAdmin();
  // Only assets this app created (under giftpacific/) may be deleted.
  if (!isAppCloudinaryPublicId(publicId)) {
    return { success: false, message: "Invalid image id." } as const;
  }
  await deleteImageFromCloudinary(publicId);
  return { success: true } as const;
}

/**
 * Deletes an upload that was removed before it was ever attached to a record (e.g. in the product create flow).
 * Safe by construction: only this app's assets, and never one that any record (product, variant, order snapshot,
 * banner, box, category, …) still references.
 */
export async function discardUnsavedUploadAction(publicId: string, url: string) {
  await requireAdmin();
  if (!isAppCloudinaryPublicId(publicId) || typeof url !== "string" || !url) {
    return { success: false, message: "Invalid image id." } as const;
  }
  try {
    if (await isCloudinaryAssetReferenced(publicId, url)) return { success: true, deleted: false } as const;
    await deleteImageFromCloudinary(publicId);
    return { success: true, deleted: true } as const;
  } catch (error) {
    logServerError("upload.discard", error, { publicId });
    return { success: false, message: "Could not remove the image." } as const;
  }
}
