import { createUploadSignatureAction } from "@/server/actions/upload.actions";
import { CloudinaryUploadError, uploadFileToCloudinary } from "@/lib/cloudinary/browser-upload";
import { validateImageFileSignature, type UploadFolder } from "@/lib/upload-validation";

export type UploadImageResult =
  | { success: true; url: string; publicId: string }
  | { success: false; message: string };

/**
 * The one entry point every admin image field uses (SingleImageUploader / GalleryImageUploader):
 *  1. check type + leading bytes of the `File` (reads 16 bytes, not the file),
 *  2. ask the server for a tiny signed-upload descriptor (Server Action; carries no image data),
 *  3. upload the `File` itself straight to Cloudinary (multipart `FormData`, chunked when very large).
 * The original is preserved as uploaded; there is no application-level size limit.
 */
export async function uploadImageFile(file: File, folder: UploadFolder, nameHint?: string): Promise<UploadImageResult> {
  const problem = await validateImageFileSignature(file);
  if (problem) return { success: false, message: problem };

  let signature: Awaited<ReturnType<typeof createUploadSignatureAction>>;
  try {
    signature = await createUploadSignatureAction(folder, nameHint);
  } catch {
    return { success: false, message: "Could not start the upload. Please try again." };
  }
  if (!signature.success) return { success: false, message: signature.message };

  try {
    const { url, publicId } = await uploadFileToCloudinary(file, signature);
    return { success: true, url, publicId };
  } catch (error) {
    if (error instanceof CloudinaryUploadError) return { success: false, message: error.message };
    return { success: false, message: "Upload failed. Please try again." };
  }
}
