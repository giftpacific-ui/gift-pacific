import type { NextConfig } from "next";
import imageHosts from "./image-hosts.json";

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
  // Don't advertise the framework ("X-Powered-By: Next.js"): no functional effect, slightly less fingerprinting.
  poweredByHeader: false,
  async rewrites() {
    // /sitemap.xml is what robots.txt advertises; see src/app/sitemap-index/route.ts.
    return { beforeFiles: [{ source: "/sitemap.xml", destination: "/sitemap-index" }], afterFiles: [], fallback: [] };
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  images: {
    // Cloudinary images are delivered pre-optimised by Cloudinary (f_auto, q_auto, responsive widths); every other
    // source still goes through the Next.js optimizer. `loader` is deliberately left at its default: setting it to
    // "custom" would switch OFF the built-in /_next/image optimizer for all non-Cloudinary images.
    // See lib/cloudinary/image-loader.ts.
    loaderFile: "./src/lib/cloudinary/image-loader.ts",
    // Allow-list lives in image-hosts.json (shared with src/lib/cloudinary/image-loader.ts). All entries are https.
    remotePatterns: imageHosts.hosts.map((hostname) => ({ protocol: "https" as const, hostname })),
  },
};

export default nextConfig;
