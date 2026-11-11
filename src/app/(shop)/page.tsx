import type { Metadata } from "next";
import {
  getActiveBanners,
  getFeaturedCategories,
  getFeaturedProducts,
  getGiftBundles,
  getLimitedEditionProducts,
  getNewArrivals,
} from "@/server/services/product.service";
import { getActiveCampaign } from "@/server/services/campaign.service";
import { getFeaturedReviews } from "@/server/services/review.service";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { Hero, type HeroSlide, type HeroSpotlight } from "@/features/home/hero";
import { CategoryMarquee } from "@/features/home/category-marquee";
import { CampaignBanner } from "@/features/home/campaign-banner";
import { FeaturedCategories } from "@/features/home/featured-categories";
import { ProductSection } from "@/features/home/product-section";
import { MidPageBanner } from "@/features/home/mid-page-banner";
import { StoryBand } from "@/features/home/story-band";
import { WhyChooseUs } from "@/features/home/trust-sections";
import { CustomerReviews } from "@/features/home/customer-reviews";
import { HelpBand } from "@/features/home/help-band";
import { siteConfig } from "@/config/site";
import { pageMetadata } from "@/server/services/seo.service";
import { organizationJsonLd, websiteJsonLd } from "@/lib/structured-data";
import { JsonLd } from "@/components/seo/json-ld";
import { ActiveCampaignSection } from "@/features/home/active-campaign-section";
import { getActiveBoxes } from "@/server/services/box.service";
import { ActiveBoxesSection } from "@/features/home/active-boxes-section";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    // Brand-first title for the home page (the brand in it makes the builder skip the "| Brand" suffix).
    title: `${siteConfig.name} – Handmade gift boxes & custom combos in Bangladesh`,
    titleIsCustom: true,
    path: "/",
  });
}

// Existing default hero copy, used only when no HERO banner is configured.
const DEFAULT_HERO = {
  title: "Gifts shaped by hand, given from the heart",
  subtitle:
    "Clay art, personalized keepsakes, and gift boxes crafted slowly — for birthdays, anniversaries, and quiet everyday moments.",
  ctaLabel: "Shop the collection",
  ctaHref: "/shop",
};

export default async function HomePage() {
  const [
    featured,
    newArrivals,
    bundles,
    limited,
    featuredCategories,
    heroBanners,
    midPageBanners,
    campaignBanners,
    activeCampaign,
    activeBoxes,
    reviews,
    settings,
  ] = await Promise.all([
    getFeaturedProducts(8),
    getNewArrivals(8),
    getGiftBundles(4),
    getLimitedEditionProducts(4),
    getFeaturedCategories(6),
    getActiveBanners("HERO"),
    getActiveBanners("MID_PAGE"),
    getActiveBanners("CAMPAIGN"),
    getActiveCampaign(),
    getActiveBoxes(),
    getFeaturedReviews(3),
    getStoreSettings(),
  ]);

  const storeName = settings?.storeName || siteConfig.name;

  // Real product photography for the hero: only products that actually have a photo.
  const withPhoto = [...featured, ...newArrivals].filter(
    (p) => p.images[0]?.url,
  );
  const seen = new Set<string>();
  const photoProducts = withPhoto.filter((p) =>
    seen.has(p.id) ? false : (seen.add(p.id), true),
  );

  const slides: HeroSlide[] =
    heroBanners.length > 0
      ? heroBanners.map((b) => ({
          title: b.title,
          subtitle: b.subtitle,
          ctaLabel: b.ctaLabel || "Shop now",
          ctaHref: b.ctaHref || "/shop",
          imageUrl: b.imageUrl,
          imageAlt: b.title,
        }))
      : [
          {
            ...DEFAULT_HERO,
            imageUrl: photoProducts[0]?.images[0]?.url ?? null,
            imageAlt: photoProducts[0]?.name ?? "",
          },
        ];

  // The small "spotlight" card is a real product that isn't the same photo as the arch.
  const spotlightProduct =
    heroBanners.length > 0 ? photoProducts[0] : photoProducts[1];
  const spotlight: HeroSpotlight | null = spotlightProduct
    ? {
        name: spotlightProduct.name,
        slug: spotlightProduct.slug,
        imageUrl: spotlightProduct.images[0]!.url,
      }
    : null;

  // Story photo: another real product photo, if there is one.
  const storyProduct = photoProducts[2] ?? photoProducts[0];
  const campaignBanner = campaignBanners[0];

  const hasAnyProducts =
    featured.length + newArrivals.length + bundles.length + limited.length > 0;

  return (
    <>
      {/* Home page only: one Organization + one WebSite entity for the whole site (no duplicates elsewhere). */}
      <JsonLd data={[organizationJsonLd(settings), websiteJsonLd(storeName)]} />
      <Hero slides={slides} spotlight={spotlight} storeName={storeName} />
      <CategoryMarquee names={featuredCategories.map((c) => c.name)} />

      {campaignBanner && (
        <CampaignBanner
          banner={{
            title: campaignBanner.title,
            subtitle: campaignBanner.subtitle,
            imageUrl: campaignBanner.imageUrl,
            ctaLabel: campaignBanner.ctaLabel,
          }}
        />
      )}

      {activeCampaign && <ActiveCampaignSection campaign={activeCampaign} />}

      <FeaturedCategories categories={featuredCategories} />

      <ProductSection
        eyebrow="Just in"
        title="New arrivals"
        viewAllHref="/shop?sort=newest"
        products={newArrivals}
        stagger
        tone="plain"
      />

      <ProductSection
        eyebrow="While they last"
        title="Limited edition"
        subtitle="Small runs — once they're gone, they're gone."
        products={limited}
        tone="sand"
      />

      <MidPageBanner banners={midPageBanners} />

      <ProductSection
        eyebrow="Featured"
        title="Our favourites"
        subtitle="Pieces we love to give."
        viewAllHref="/shop"
        viewAllLabel="View all products"
        products={featured}
        stagger
        indexed
        tone="sand"
      />

      <ProductSection
        eyebrow="Gift boxes"
        title="Ready to give"
        subtitle="Curated boxes and bundles, packed together."
        viewAllHref="/boxes"
        products={bundles}
        tone="plain"
      />

      {!hasAnyProducts && (
        <section className="container-boutique section-y text-center bg-secondary">
          <h2 className="font-heading text-3xl font-semibold">
            New pieces are on their way
          </h2>
          <p className="mt-2 text-muted-foreground">
            Our shelves are being filled — please check back soon.
          </p>
        </section>
      )}

      <ActiveBoxesSection boxes={activeBoxes} />

      {/* <WhyChooseUs />
      <HelpBand />
      <StoryBand
        imageUrl={campaignBanner?.imageUrl ?? null}
        imageCaption={storyProduct ? storyProduct.name : null}
      /> */}
      <CustomerReviews reviews={reviews} />
    </>
  );
}
