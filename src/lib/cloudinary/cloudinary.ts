import "server-only";
import { v2 as cloudinary } from "cloudinary";
import { CLOUDINARY_ALLOWED_FORMATS, CLOUDINARY_FOLDER_PREFIX, type UploadFolder } from "@/lib/upload-validation";

let configured = false;

/**
 * Configures the Cloudinary SDK once, lazily, on first use — rather than at
 * module import time — so importing this file never throws just because
 * Cloudinary credentials aren't set (e.g. in local dev before they've been
 * configured). Upload/delete calls will fail with a clear error instead.
 */
function ensureConfigured() {
  if (configured) return;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in your environment.",
    );
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  configured = true;
}

/**
 * Everything the browser needs to upload one file DIRECTLY to Cloudinary. Contains the public API key and a
 * signature, never the API secret. The signed parameters (folder, public_id, allowed_formats, timestamp) are fixed
 * by the server: the browser cannot change the destination folder or the allowed formats without invalidating it.
 */
export type SignedUploadParams = {
  uploadUrl: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  /** Present only when a readable name hint was given; otherwise Cloudinary generates the id (as before). */
  publicId?: string;
  allowedFormats: string;
};

/**
 * Creates the signed parameters for a direct browser -> Cloudinary upload. Folder structure and public-id scheme are
 * identical to the previous server-side upload ("giftpacific/<folder>", readable "<name>-<8 hex>" public id).
 * No transformation/eager/incoming parameters are signed: the ORIGINAL file is stored untouched; resizing and
 * format/quality optimisation happen at delivery time (see lib/cloudinary/image-loader.ts).
 */
export function createSignedUploadParams(
  folder: UploadFolder,
  nameHint?: string,
): SignedUploadParams {
  ensureConfigured();
  const { cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret } = cloudinary.config();
  // A readable public id ("blue-ceramic-mug-3f9a1c2b") instead of a random string: it becomes the image file name.
  const base = (nameHint ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const publicId = base ? `${base}-${crypto.randomUUID().slice(0, 8)}` : undefined;
  const timestamp = Math.round(Date.now() / 1000);
  const toSign: Record<string, string | number> = {
    allowed_formats: CLOUDINARY_ALLOWED_FORMATS,
    folder: `${CLOUDINARY_FOLDER_PREFIX}${folder}`,
    timestamp,
    ...(publicId ? { public_id: publicId } : {}),
  };
  const signature = cloudinary.utils.api_sign_request(toSign, apiSecret as string);
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    apiKey: apiKey as string,
    timestamp,
    signature,
    folder: toSign.folder as string,
    ...(publicId ? { publicId } : {}),
    allowedFormats: CLOUDINARY_ALLOWED_FORMATS,
  };
}

/**
 * Deletes an asset from Cloudinary by its public_id. Safe to call with a
 * null/undefined id (e.g. an image that was added as a raw URL, not
 * uploaded) — it's a no-op in that case rather than an error, since not
 * every image in the system necessarily came from Cloudinary.
 */
export async function deleteImageFromCloudinary(publicId: string | null | undefined) {
  if (!publicId) return;
  ensureConfigured();
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (error) {
    // Deletion failures shouldn't block the surrounding admin action (e.g.
    // saving a product) — log and move on. Worst case is one orphaned
    // asset in Cloudinary, not a broken product/order.
    console.error(`Failed to delete Cloudinary asset ${publicId}:`, error);
  }
}

export function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET,
  );
}
