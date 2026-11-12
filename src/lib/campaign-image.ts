/**
 * Pure rules for the campaign form's image field. A campaign stores ONLY an image URL (`Collection.image`); there is
 * no public-id column, so the public id is known only for an image uploaded during the current form session.
 */

export type CampaignImageAsset = { url: string; publicId: string | null };
export type CampaignImageState = { uploaded: CampaignImageAsset | null; urlText: string };

/** Images this app uploaded live on Cloudinary; anything else was typed in by hand (older campaigns). */
export function isCloudinaryUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https:\/\/res\.cloudinary\.com\//i.test(url);
}

/**
 * Initial state for create (no saved image) or edit. A saved Cloudinary image is shown in the uploader; a saved URL
 * typed by hand earlier stays in the plain URL field, so the admin form never tries to preview an arbitrary host and
 * existing campaigns keep working unchanged.
 */
export function initialImageState(saved: string | null | undefined): CampaignImageState {
  if (isCloudinaryUrl(saved)) return { uploaded: { url: saved, publicId: null }, urlText: "" };
  return { uploaded: null, urlText: saved ?? "" };
}

/** The single string stored in `Collection.image` ("" = no image). An uploaded image wins over the URL field. */
export function imageForSave(state: CampaignImageState): string {
  return state.uploaded?.url ?? state.urlText.trim();
}

/**
 * Which asset to discard when the uploaded image changes. Only an image uploaded in THIS session (public id known) is
 * ever a candidate; a saved image (public id unknown) is never touched. The server-side discard additionally refuses
 * to delete any asset a record still references.
 */
export function assetToDiscard(
  previous: CampaignImageAsset | null,
  next: CampaignImageAsset | null,
): CampaignImageAsset | null {
  if (previous?.publicId && previous.url !== next?.url) return previous;
  return null;
}
