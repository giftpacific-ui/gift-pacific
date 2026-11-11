/* eslint-disable @typescript-eslint/no-explicit-any */
export function isCloudinaryConfigured() {
  return true;
}
export async function uploadImageToCloudinary(dataUrl: string, folder: string) {
  (globalThis as any).__TEST_UPLOADS__ = [...((globalThis as any).__TEST_UPLOADS__ ?? []), { dataUrl, folder }];
  return { url: "https://res.cloudinary.com/test/image/upload/x.png", publicId: `giftpacific/${folder}/x` };
}
export async function deleteImageFromCloudinary() {}
