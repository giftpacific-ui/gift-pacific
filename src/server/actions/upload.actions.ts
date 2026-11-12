"use server";

import { requireAdmin } from "@/lib/auth/current-user";
import {
  createSignedUploadParams,
  deleteImageFromCloudinary,
  isCloudinaryConfigured,
  type SignedUploadParams,
} from "@/lib/cloudinary/cloudinary";
import { logServerError } from "@/lib/logger";
import { isCloudinaryAssetReferenced } from "@/server/services/admin-product.service";
import { isAppCloudinaryPublicId, UPLOAD_FOLDERS, type UploadFolder } from "@/lib/upload-validation";

export type UploadSignatureResult =
  | ({ success: true } & SignedUploadParams)
  | { success: false; message: string };

/**
 * Step 1 of an admin image upload. Returns a short-lived Cloudinary signature (a few hundred bytes) so the browser
 * can upload the file DIRECTLY to Cloudinary as multipart `File` data. The image itself never travels through this
 * Server Action (React's Server Action decoder rejects large string arguments, which is what used to break large
 * uploads), and the API secret never leaves the server - only the public API key and the signature are returned.
 *
 * Used by every admin image field (SingleImageUploader / GalleryImageUploader): product thumbnail/gallery, banner,
 * category, box, team member, store logo/favicon. Folder structure ("giftpacific/<folder>") and the readable public
 * id are generated exactly as before, and are part of the signed parameters, so the client cannot redirect the upload.
 */
export async function createUploadSignatureAction(
  folder: UploadFolder,
  /** Optional readable name (e.g. the product name) used for the stored file name. */
  nameHint?: string,
): Promise<UploadSignatureResult> {
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

  try {
    const params = createSignedUploadParams(folder, typeof nameHint === "string" ? nameHint.slice(0, 120) : undefined);
    return { success: true, ...params };
  } catch (error) {
    logServerError("upload.signature", error, { folder });
    return { success: false, message: "Could not start the upload. Please try again." };
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
