import type { Metadata } from "next";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { getCanonicalOrigin } from "@/server/services/seo.service";
import { GlobalSeoForm } from "@/features/admin/seo/global-seo-form";

export const metadata: Metadata = { title: "SEO settings · Admin" };

export default async function SeoSettingsPage() {
  const [s, origin] = await Promise.all([getStoreSettings(), getCanonicalOrigin()]);
  return (
    <GlobalSeoForm siteName={s.storeName} effectiveOrigin={origin}
      initial={{
        seoDefaultTitle: s.seoDefaultTitle ?? "", seoTitleTemplate: s.seoTitleTemplate ?? "", seoDescription: s.seoDescription ?? "", seoKeywords: s.seoKeywords,
        seoOgTitle: s.seoOgTitle ?? "", seoOgDescription: s.seoOgDescription ?? "", ogImageUrl: s.ogImageUrl ?? "",
        seoTwitterCard: s.seoTwitterCard === "summary" ? "summary" : "summary_large_image", seoCanonicalBaseUrl: s.seoCanonicalBaseUrl ?? "",
        seoDefaultNoIndex: s.seoDefaultNoIndex, seoDefaultNoFollow: s.seoDefaultNoFollow, seoRobotsExtra: s.seoRobotsExtra ?? "",
        seoOrgSchemaEnabled: s.seoOrgSchemaEnabled, seoWebsiteSchemaEnabled: s.seoWebsiteSchemaEnabled,
      }} />
  );
}
