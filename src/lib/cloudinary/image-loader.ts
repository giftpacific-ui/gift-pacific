import type { ImageLoaderProps } from "next/image";

/**
 * Global `next/image` loader (configured in next.config.ts).
 * Deliberately NO "use client": Server Components call the loader while rendering <Image>, so it must be a plain
 * isomorphic module (a pure function with no browser or server-only dependencies).
 *
 * Originals in Cloudinary are stored exactly as uploaded (possibly very large). For Cloudinary-hosted images this
 * loader asks Cloudinary - not the Next.js server - for a right-sized rendition, so the full original is never
 * downloaded and re-encoded by our server:
 *   f_auto   best format for the visitor's browser (AVIF/WebP/JPEG/PNG)
 *   q_auto   automatic quality
 *   c_limit,w_<width>   resize down to the width Next asks for (responsive srcset widths); never upscales
 * The transformation is appended AFTER any transformation already present in a stored URL, so existing crop/resize
 * URLs keep working. Every other image (picsum, Unsplash, local files, ...) takes the normal Next.js optimizer path
 * exactly as before (`/_next/image?url=...&w=...&q=...`).
 */

const CLOUDINARY_UPLOAD_URL = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/;
// A Cloudinary transformation segment: "c_fill,w_800,h_400", "f_auto", "t_named". Not a version ("v1234") or a folder.
const TRANSFORMATION_SEGMENT = /^[a-z]{1,3}_[^/,]+(,[a-z]{1,3}_[^/,]+)*$/i;

export const DELIVERY_TRANSFORMATION = "f_auto,q_auto,c_limit";

/** Returns the optimised Cloudinary URL for `src` at `width`, or null when `src` is not a Cloudinary upload URL. */
export function cloudinaryDeliveryUrl(src: string, width: number): string | null {
  const match = CLOUDINARY_UPLOAD_URL.exec(src);
  if (!match) return null;
  const [, prefix, rest] = match;
  const segments = rest.split("/");
  let i = 0;
  while (i < segments.length - 1 && TRANSFORMATION_SEGMENT.test(segments[i])) i++;
  const existing = segments.slice(0, i);
  const remainder = segments.slice(i);
  return `${prefix}${[...existing, `${DELIVERY_TRANSFORMATION},w_${width}`, ...remainder].join("/")}`;
}

export default function cloudinaryAwareLoader({ src, width, quality }: ImageLoaderProps): string {
  return (
    cloudinaryDeliveryUrl(src, width) ??
    `/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=${quality || 75}`
  );
}
