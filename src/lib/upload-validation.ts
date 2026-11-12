/**
 * Upload hardening for the direct browser -> Cloudinary flow.
 *
 * Files never pass through a Server Action: the browser uploads the `File` itself straight to Cloudinary using a
 * short-lived signature minted by the server (see `server/actions/upload.actions.ts`). What we still enforce:
 *
 * - an explicit MIME allow-list (JPEG / PNG / WebP; SVG and everything else rejected - SVG can carry script),
 * - the file's leading bytes (magic numbers) must really be that format,
 * - `allowed_formats` is part of the SIGNED upload parameters, so Cloudinary itself refuses any other format
 *   even if this client-side check were bypassed.
 *
 * There is deliberately NO application-level file-size cap. The only size limits are Cloudinary's own account/plan
 * limits, which Cloudinary reports and `lib/cloudinary/browser-upload.ts` surfaces to the admin verbatim.
 */

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** Cloudinary `allowed_formats` value matching ALLOWED_IMAGE_MIME_TYPES (Cloudinary names JPEG "jpg"). */
export const CLOUDINARY_ALLOWED_FORMATS = "jpg,png,webp";

export type UploadFolder = "products" | "banners" | "branding" | "categories" | "team" | "boxes";
export const UPLOAD_FOLDERS: readonly UploadFolder[] = ["products", "banners", "branding", "categories", "team", "boxes"];

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** Detects JPEG / PNG / WebP from the first bytes of a file. Returns null for anything else. */
export function detectMime(head: Uint8Array): AllowedImageMime | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF....WEBP
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

/** Instant, synchronous pre-check (type only - there is no size limit). */
export function validateImageFileClientSide(file: { type: string }): string | null {
  if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return "Please choose a JPEG, PNG or WebP image.";
  }
  return null;
}

/**
 * Reads only the first 16 bytes of the file (never the whole file) and checks they match the declared type.
 * Returns an error message, or null when the file is acceptable.
 */
export async function validateImageFileSignature(file: Blob & { type: string }): Promise<string | null> {
  const typeProblem = validateImageFileClientSide(file);
  if (typeProblem) return typeProblem;
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch {
    return "Could not read this file. Please try another one.";
  }
  const detected = detectMime(head);
  if (detected === null || detected !== file.type) return "The file isn't a valid JPEG, PNG or WebP image.";
  return null;
}

/** Cloudinary public ids this app creates always live under this prefix. */
export const CLOUDINARY_FOLDER_PREFIX = "giftpacific/";
export function isAppCloudinaryPublicId(publicId: unknown): publicId is string {
  return (
    typeof publicId === "string" &&
    publicId.startsWith(CLOUDINARY_FOLDER_PREFIX) &&
    publicId.length <= 255 &&
    !publicId.includes("..")
  );
}
