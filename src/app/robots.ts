import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // Everything public (pages, product/category URLs, CSS, JS, images) stays crawlable.
        allow: "/",
        // Private or useless-to-index areas. Filter/sort/search variants of the shop stay crawlable ON PURPOSE:
        // they carry noindex + a canonical to the clean listing, which crawlers can only see if they may fetch them.
        disallow: ["/admin", "/account", "/cart", "/checkout", "/login", "/register", "/forgot-password", "/reset-password", "/search", "/docs", "/api/"],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
