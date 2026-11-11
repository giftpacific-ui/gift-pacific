/**
 * Upload hardening for the (existing) data-URL → Cloudinary flow.
 *
 * `data:image/` alone is not a safe check: it accepts image/svg+xml (which
 * can carry script) and anything else that claims to be an image. This
 * module enforces an explicit MIME allow-list, verifies the decoded bytes
 * really are that format (magic numbers), and bounds the size.
 */

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** Raw (decoded) image size limit. Unchanged from the previous behavior. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Longest legal data URL: base64 expands raw bytes by 4/3, plus a short header. */
export const MAX_DATA_URL_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 64;

/**
 * Next.js Server Actions reject request bodies over 1 MB by default — which
 * contradicts an 8 MB upload limit. `next.config.ts` raises
 * `serverActions.bodySizeLimit` to this value, which must always be
 * >= MAX_DATA_URL_LENGTH (asserted by a unit test).
 */
export const SERVER_ACTION_BODY_LIMIT_MB = 11;

export type UploadValidation =
  | { ok: true; mime: AllowedImageMime; bytes: number }
  | { ok: false; message: string };

const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

function detectMime(head: Uint8Array): AllowedImageMime | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF....WEBP
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

export function validateImageDataUrl(dataUrl: unknown): UploadValidation {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return { ok: false, message: "Please choose an image file." };
  }
  if (dataUrl.length > MAX_DATA_URL_LENGTH) {
    return { ok: false, message: "Image is too large — please use a file under 8MB." };
  }

  const comma = dataUrl.indexOf(",");
  if (comma === -1) return { ok: false, message: "Please choose an image file." };

  const header = dataUrl.slice(5, comma); // between "data:" and ","
  const [mimeRaw, encoding, ...rest] = header.split(";");
  const mime = mimeRaw.trim().toLowerCase();
  if (encoding !== "base64" || rest.length > 0) {
    return { ok: false, message: "Unsupported image encoding." };
  }
  if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) {
    return { ok: false, message: "Unsupported image type. Please upload a JPEG, PNG or WebP image." };
  }

  const body = dataUrl.slice(comma + 1);
  if (body.length === 0 || body.length % 4 !== 0 || !BASE64_BODY.test(body)) {
    return { ok: false, message: "The image data is corrupted. Please try another file." };
  }

  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  const bytes = (body.length / 4) * 3 - padding;
  if (bytes > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "Image is too large — please use a file under 8MB." };
  }

  let head: Uint8Array;
  try {
    const binary = atob(body.slice(0, 24)); // 24 base64 chars = 18 bytes
    head = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, message: "The image data is corrupted. Please try another file." };
  }

  const detected = detectMime(head);
  if (detected === null || detected !== mime) {
    return { ok: false, message: "The file isn't a valid JPEG, PNG or WebP image." };
  }

  return { ok: true, mime: detected, bytes };
}

/** Client-side pre-check (type + size) so users get instant feedback; the server re-validates. */
export function validateImageFileClientSide(file: { type: string; size: number }): string | null {
  if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return "Please choose a JPEG, PNG or WebP image.";
  }
  if (file.size > MAX_UPLOAD_BYTES) return "Image is too large — please use a file under 8MB.";
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
