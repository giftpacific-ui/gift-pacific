import Image from "next/image";
import Link from "next/link";

/**
 * Campaign banner: ONE image with a title and a single link to /campaign.
 * Deliberately no product carousel or embedded product list — the products
 * live on the /campaign page.
 */
export function CampaignBanner({
  banner,
}: {
  banner: {
    title: string;
    subtitle: string | null;
    imageUrl: string;
    ctaLabel: string | null;
  };
}) {
  return (
    <section className="bg-secondary section-y">
      <div className="container mx-auto px-3">
        <Link
          href="/campaign"
          aria-label={banner.title}
          className="group relative block aspect-4/3 w-full overflow-hidden rounded-[4px] bg-secondary sm:aspect-3/1"
        >
          <Image
            src={banner.imageUrl}
            alt=""
            fill
            sizes="100vw"
            className="product-image-tone object-cover transition-transform duration-700 group-hover:scale-[1.03]"
          />
          <span className="absolute inset-0 flex flex-col items-start justify-center gap-3 bg-black/45 px-5 sm:px-14">
            <span className="max-w-md text-balance font-heading text-2xl text-white sm:text-4xl">
              {banner.title}
            </span>
            {banner.subtitle && (
              <span className="max-w-sm text-balance text-sm text-white/90 sm:text-base">
                {banner.subtitle}
              </span>
            )}
            <span className="inline-flex h-11 items-center rounded-[3px] bg-secondary px-6 text-sm font-semibold text-black transition-colors hover:bg-primary hover:text-white">
              {banner.ctaLabel || "Shop the campaign"}
            </span>
          </span>
        </Link>
      </div>
    </section>
  );
}
