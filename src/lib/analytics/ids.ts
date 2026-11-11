/**
 * Tracking IDs are interpolated into inline <script> snippets, so they must
 * be validated against the real ID formats — never trusted as free text.
 * (A value like  ');alert(1);//  would otherwise execute on every page.)
 */
export const GA4_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;
export const GTM_ID_PATTERN = /^GTM-[A-Z0-9]{4,20}$/;
export const META_PIXEL_ID_PATTERN = /^\d{5,20}$/;

/** Stable id shared by the browser Purchase event and the optional server event, so they de-duplicate. */
export function purchaseEventId(orderNumber: string) {
  return `purchase_${orderNumber}`;
}

export function isValidTrackingId(value: string | null | undefined): value is string {
  return !!value && (GA4_ID_PATTERN.test(value) || GTM_ID_PATTERN.test(value));
}

export function isValidPixelId(value: string | null | undefined): value is string {
  return !!value && META_PIXEL_ID_PATTERN.test(value);
}

/**
 * TikTok pixel codes are ~20 upper-case letters/digits; LinkedIn Insight partner ids are numeric.
 * Both are interpolated into inline scripts, so they are validated against these shapes (the
 * formats are from the providers' public setup flows and are NOT verified against a live account).
 */
export const TIKTOK_PIXEL_ID_PATTERN = /^[A-Z0-9]{10,30}$/;
export const LINKEDIN_PARTNER_ID_PATTERN = /^\d{4,12}$/;

export const isValidTikTokId = (v: string | null | undefined): v is string => !!v && TIKTOK_PIXEL_ID_PATTERN.test(v);
export const isValidLinkedInId = (v: string | null | undefined): v is string => !!v && LINKEDIN_PARTNER_ID_PATTERN.test(v);
