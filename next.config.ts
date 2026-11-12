import type { NextConfig } from "next";

/**
 * Baseline response headers for every route (Phase "emergency release").
 * - nosniff: browsers must not guess a different content type for our responses.
 * - X-Frame-Options DENY: no page of this site may be framed by another site (clickjacking, esp. /admin). The site only
 *   EMBEDS others (YouTube players, the GTM noscript iframe), which this header does not affect; nothing frames our own pages.
 * - Referrer-Policy: send only the origin to other sites over https, never full URLs (order numbers, search terms).
 * A Content-Security-Policy is deliberately NOT set here: it must be designed and tested against GTM, Meta Pixel,
 * Cloudinary and the inline JSON-LD before being enabled (HANDOFF_GIFTPACIFIC.md, roadmap phase 10).
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  images: {
    // Cloudinary images are delivered pre-optimised by Cloudinary (f_auto, q_auto, responsive widths); every other
    // source still goes through the Next.js optimizer. `loader` is deliberately left at its default: setting it to
    // "custom" would switch OFF the built-in /_next/image optimizer for all non-Cloudinary images.
    // See lib/cloudinary/image-loader.ts.
    loaderFile: "./src/lib/cloudinary/image-loader.ts",
    remotePatterns: [
      // Seed data uses placeholder images from picsum.photos.
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "fastly.picsum.photos" },
      // Common hosting targets for real product photography.
      { protocol: "https", hostname: "res.cloudinary.com" },
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "images.unsplash.com" },
      // YouTube image & thumbnail domains
      { protocol: "https", hostname: "img.youtube.com" },
      { protocol: "https", hostname: "i.ytimg.com" },
      {
        protocol: "https",
        hostname: "*.fbcdn.net",
      },
    ],
  },
};

export default nextConfig;
