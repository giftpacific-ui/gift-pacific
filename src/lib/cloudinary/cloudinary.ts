import "server-only";
import { v2 as cloudinary } from "cloudinary";

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

export type CloudinaryUploadResult = {
  url: string;
  publicId: string;
};

/**
 * Uploads a base64 data URL (what the browser's FileReader produces) to
 * Cloudinary under a folder so assets stay organized by type.
 */
export async function uploadImageToCloudinary(
  dataUrl: string,
  folder: "products" | "banners" | "branding" | "categories" | "team" | "boxes",
  nameHint?: string,
): Promise<CloudinaryUploadResult> {
  ensureConfigured();
  // A readable public id ("blue-ceramic-mug-3f9a1c2b") instead of a random string: it becomes the image file name.
  const base = (nameHint ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const result = await cloudinary.uploader.upload(dataUrl, {
    folder: `giftpacific/${folder}`,
    resource_type: "image",
    ...(base ? { public_id: `${base}-${crypto.randomUUID().slice(0, 8)}` } : {}),
  });
  return { url: result.secure_url, publicId: result.public_id };
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
