import { keywordsForMetadata } from "@/lib/seo-keywords";
import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { Cormorant, Manrope, Noto_Serif_Bengali } from "next/font/google";
import { Toaster } from "sonner";
import { Providers } from "@/app/providers";
import { siteConfig } from "@/config/site";
import { AnalyticsRoot } from "@/lib/analytics/analytics-scripts";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { getCanonicalOrigin } from "@/server/services/seo.service";
import { readableForeground } from "@/lib/color-contrast";
import { BRAND_PRIMARY, resolveThemeOverrides } from "@/lib/theme";
import "@/app/globals.css";

const cormorant = Cormorant({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-cormorant",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-manrope",
  display: "swap",
});

const notoSerifBengali = Noto_Serif_Bengali({
  subsets: ["bengali"],
  weight: ["500", "600", "700"],
  variable: "--font-noto-bengali",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getStoreSettings();
  const brand = settings.storeName?.trim() || siteConfig.name;
  const origin = await getCanonicalOrigin();
  const template = settings.seoTitleTemplate?.includes("%s")
    ? settings.seoTitleTemplate
    : `%s | ${brand}`;
  const description = settings.seoDescription || siteConfig.description;
  const defaultTitle = settings.seoDefaultTitle?.trim() || brand;
  const ogTitle = settings.seoOgTitle?.trim() || defaultTitle;
  const ogDescription = settings.seoOgDescription?.trim() || description;
  const image = settings.ogImageUrl
    ? [{ url: settings.ogImageUrl }]
    : undefined;

  const facebookDomainVerification =
    process.env.FACEBOOK_DOMAIN_VERIFICATION?.trim() || "";

  return {
    metadataBase: new URL(origin),
    title: {
      default: defaultTitle,
      template,
    },
    description,
    keywords: keywordsForMetadata(settings.seoKeywords),
    icons: settings.faviconUrl ? { icon: settings.faviconUrl } : undefined,
    robots: {
      index: !settings.seoDefaultNoIndex,
      follow: !settings.seoDefaultNoFollow,
    },
    ...(facebookDomainVerification
      ? {
          other: {
            "facebook-domain-verification": facebookDomainVerification,
          },
        }
      : {}),
    openGraph: {
      type: "website",
      title: ogTitle,
      description: ogDescription,
      url: origin,
      siteName: brand,
      images: image,
    },
    twitter: {
      card:
        settings.ogImageUrl && settings.seoTwitterCard !== "summary"
          ? "summary_large_image"
          : "summary",
      title: ogTitle,
      description: ogDescription,
      images: settings.ogImageUrl ? [settings.ogImageUrl] : undefined,
    },
  };
}

export async function generateViewport() {
  const settings = await getStoreSettings();
  return {
    themeColor: resolveThemeOverrides(settings).primary ?? BRAND_PRIMARY,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const settings = await getStoreSettings();
  const trackingId = settings.gtmId || process.env.NEXT_PUBLIC_GTM_ID || null;
  const pixelId =
    settings.metaPixelId || process.env.NEXT_PUBLIC_META_PIXEL_ID || null;
  const tiktokId = settings.tiktokPixelId || null;
  const linkedinId = settings.linkedinPartnerId || null;

  const themeStyle: Record<string, string> = {};
  const theme = resolveThemeOverrides(settings);
  if (theme.primary) {
    themeStyle["--primary"] = theme.primary;
    themeStyle["--primary-foreground"] = readableForeground(theme.primary);
    themeStyle["--ring"] = theme.primary;
  }
  if (theme.secondary) {
    themeStyle["--secondary"] = theme.secondary;
    themeStyle["--secondary-foreground"] = readableForeground(theme.secondary);
  }

  return (
    <html
      lang="en"
      className={`${cormorant.variable} ${manrope.variable} ${notoSerifBengali.variable} h-full antialiased`}
      style={
        Object.keys(themeStyle).length > 0
          ? (themeStyle as CSSProperties)
          : undefined
      }
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <AnalyticsRoot
          consentMode={settings.consentMode}
          trackingId={trackingId}
          pixelId={pixelId}
          tiktokId={tiktokId}
          linkedinId={linkedinId}
        />

        <Providers>
          {children}
          <Toaster richColors position="top-center" />
        </Providers>
      </body>
    </html>
  );
}
