/* eslint-disable @typescript-eslint/no-explicit-any */
export function isCloudinaryConfigured() {
  return true;
}
/** Records what the server was asked to sign; returns a fake descriptor (the real signer has its own test). */
export function createSignedUploadParams(folder: string, nameHint?: string) {
  (globalThis as any).__TEST_UPLOADS__ = [...((globalThis as any).__TEST_UPLOADS__ ?? []), { folder, nameHint }];
  return {
    uploadUrl: "https://api.cloudinary.com/v1_1/test/image/upload",
    apiKey: "test-key",
    timestamp: 1700000000,
    signature: "test-signature",
    folder: `giftpacific/${folder}`,
    allowedFormats: "jpg,png,webp",
  };
}
export async function deleteImageFromCloudinary() {}
