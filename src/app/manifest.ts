import type { MetadataRoute } from "next";
import { siteConfig } from "@/config/site";

/**
 * Minimal web app manifest (served at /manifest.webmanifest; Next.js links it from every page's <head>).
 *
 * Deliberately minimal (Phase 1 branding):
 * - NO `icons`: no official Gift Pacific logo/favicon asset exists yet, and icon paths must never be invented or point
 *   at files that do not exist. Without icons browsers will not offer "install app" - that is intended until the owner
 *   supplies official assets (then add them here and in HANDOFF_GIFTPACIFIC.md).
 * - NO service worker / offline caching (out of scope).
 * - NO theme_color / background_color: the theme colour is configured in Admin -> Settings and already emitted through
 *   the root layout's viewport metadata; a hard-coded copy here could drift from it.
 * - `display: "browser"`: this is a storefront, not an installed app experience.
 * - `lang: "en"` matches the root layout's <html lang="en">; the app has no other locale configuration.
 * - Static by design (name comes from siteConfig), so it needs no database access at build or request time.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteConfig.name,
    short_name: siteConfig.shortName,
    start_url: "/",
    scope: "/",
    display: "browser",
    lang: "en",
  };
}
