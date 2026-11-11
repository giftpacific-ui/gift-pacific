import { AnnouncementBar } from "@/components/layout/announcement-bar";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { StorefrontOverlays } from "@/components/layout/storefront-overlays";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { getSession } from "@/lib/auth/current-user";
import { PromoPopup } from "@/features/home/promo-popup";
import { getActiveBanners } from "@/server/services/product.service";

export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, popupBanners] = await Promise.all([getSession(), getActiveBanners("POPUP")]);
  const popup = popupBanners[0];
  return (
    <>
      <a
        href="#main-content"
        className="sr-only z-50 rounded bg-foreground px-4 py-2 text-background focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <AnnouncementBar />
      <Navbar />
      <MobileBottomNav isSignedIn={!!session} />
      <main id="main-content" className="flex-1 bg-secondary">
        {children}
      </main>
      <div className="pb-16 lg:pb-0">
        <Footer />
      </div>
      <StorefrontOverlays />
      {popup && (
        <PromoPopup
          banner={{
            id: popup.id,
            title: popup.title,
            subtitle: popup.subtitle,
            imageUrl: popup.imageUrl,
            ctaLabel: popup.ctaLabel,
            ctaHref: popup.ctaHref,
          }}
        />
      )}
    </>
  );
}
