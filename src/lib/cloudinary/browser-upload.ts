import type { SignedUploadParams } from "@/lib/cloudinary/cloudinary";

/**
 * Browser-side direct upload to Cloudinary (no server round-trip for the file, no base64, no Server Action payload).
 *
 * - The `File` object itself goes into `FormData` (multipart). The browser streams it from disk; it is never read
 *   into a JS string or byte array.
 * - Small/medium files: one POST. Files above CHUNK_THRESHOLD_BYTES: Cloudinary's chunked ("resumable") protocol - the
 *   same signed parameters on every request plus `X-Unique-Upload-Id` and `Content-Range` headers. Each chunk is
 *   retried on network errors / 5xx, so a flaky connection doesn't force the whole file to restart.
 * - There is NO application-level size cap. If Cloudinary refuses a file (its plan/account limit, or its megapixel
 *   limit) that response is surfaced explicitly as a `CloudinaryUploadError` with `providerLimit: true`.
 *
 * The original file is stored as uploaded. Resizing / format / quality happen only at delivery time.
 */

/** Files larger than this are sent in chunks. */
export const CHUNK_THRESHOLD_BYTES = 20 * 1024 * 1024;
/** Chunk size (Cloudinary requires non-final chunks to be at least 5 MB). */
export const CHUNK_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_CHUNK_ATTEMPTS = 3;

export type DirectUploadResult = { url: string; publicId: string; bytes?: number; format?: string };

export class CloudinaryUploadError extends Error {
  readonly providerLimit: boolean;
  constructor(message: string, providerLimit = false) {
    super(message);
    this.name = "CloudinaryUploadError";
    this.providerLimit = providerLimit;
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type UploadableFile = Blob & { name?: string };

function buildForm(sig: SignedUploadParams, body: Blob, fileName: string): FormData {
  const form = new FormData();
  form.append("file", body, fileName);
  form.append("api_key", sig.apiKey);
  form.append("timestamp", String(sig.timestamp));
  form.append("signature", sig.signature);
  form.append("folder", sig.folder);
  form.append("allowed_formats", sig.allowedFormats);
  if (sig.publicId) form.append("public_id", sig.publicId);
  return form;
}

// Messages Cloudinary uses when an ACCOUNT/PLAN limit (not this app) rejects the file.
const PROVIDER_LIMIT_RE = /(file size too large|too large|maximum is|exceeds|megapixel|limit)/i;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorFromResponse(status: number, json: Record<string, unknown>): CloudinaryUploadError {
  const raw = (json.error as { message?: string } | undefined)?.message;
  if (raw && PROVIDER_LIMIT_RE.test(raw)) {
    return new CloudinaryUploadError(
      `Cloudinary rejected this image: "${raw}". This is a limit of the Cloudinary plan used by this store, not of the admin panel. Use a smaller image, or ask the account owner to raise the Cloudinary plan limit.`,
      true,
    );
  }
  if (raw) return new CloudinaryUploadError(`Cloudinary could not accept this image: ${raw}`);
  return new CloudinaryUploadError(`Upload failed (HTTP ${status}). Please try again.`);
}

function toResult(json: Record<string, unknown>, sig: SignedUploadParams): DirectUploadResult {
  const url = json.secure_url;
  const publicId = json.public_id;
  if (typeof url !== "string" || typeof publicId !== "string") {
    throw new CloudinaryUploadError("Upload finished but Cloudinary returned an unexpected response. Please try again.");
  }
  // Defence in depth: the asset must be where the signature said it would be, and a format we allow.
  if (!publicId.startsWith(`${sig.folder}/`) && publicId !== sig.folder) {
    throw new CloudinaryUploadError("Cloudinary stored the image in an unexpected location. Please try again.");
  }
  const format = typeof json.format === "string" ? json.format : undefined;
  if (format && !sig.allowedFormats.split(",").includes(format)) {
    throw new CloudinaryUploadError("The file isn't a valid JPEG, PNG or WebP image.");
  }
  return { url, publicId, bytes: typeof json.bytes === "number" ? json.bytes : undefined, format };
}

export async function uploadFileToCloudinary(
  file: UploadableFile,
  sig: SignedUploadParams,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<DirectUploadResult> {
  const fileName = file.name || "upload";
  const total = file.size;

  if (total <= CHUNK_THRESHOLD_BYTES) {
    let res: Response;
    try {
      res = await fetchImpl(sig.uploadUrl, { method: "POST", body: buildForm(sig, file, fileName) });
    } catch {
      throw new CloudinaryUploadError("Network error while uploading. Check your connection and try again.");
    }
    const json = await readJson(res);
    if (!res.ok) throw errorFromResponse(res.status, json);
    return toResult(json, sig);
  }

  // Chunked / resumable upload for very large files.
  const uploadId = crypto.randomUUID();
  let last: Record<string, unknown> = {};
  for (let start = 0; start < total; start += CHUNK_SIZE_BYTES) {
    const end = Math.min(start + CHUNK_SIZE_BYTES, total) - 1;
    const chunk = file.slice(start, end + 1);
    let json: Record<string, unknown> | null = null;
    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS && json === null; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetchImpl(sig.uploadUrl, {
          method: "POST",
          body: buildForm(sig, chunk, fileName),
          headers: { "X-Unique-Upload-Id": uploadId, "Content-Range": `bytes ${start}-${end}/${total}` },
        });
      } catch {
        res = null; // network failure: retry this chunk
      }
      if (res === null || res.status >= 500) {
        if (attempt === MAX_CHUNK_ATTEMPTS) {
          throw new CloudinaryUploadError("The upload was interrupted. Check your connection and try again.");
        }
        continue;
      }
      const parsed = await readJson(res);
      if (!res.ok) throw errorFromResponse(res.status, parsed);
      json = parsed;
    }
    last = json ?? {};
  }
  return toResult(last, sig);
}
