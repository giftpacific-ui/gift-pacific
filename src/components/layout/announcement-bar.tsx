import Link from "next/link";
import Image from "next/image";
import { getActiveBanners } from "@/server/services/product.service";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { formatPrice } from "@/lib/utils";
import { isSafeLinkTarget } from "@/lib/url-safety";
import { Banner } from "@/types/banner";

export async function AnnouncementBar() {
  const [banners, settings] = await Promise.all([
    getActiveBanners("PROMO_STRIP") as Promise<Banner[]>,
    getStoreSettings(),
  ]);

  const banner = banners?.[0];
  const threshold = settings?.freeShippingThreshold
    ? Number(settings.freeShippingThreshold)
    : null;

  // Render check
  if (!banner && (!threshold || threshold <= 0)) {
    return null;
  }

  // Banner dynamic properties extraction
  const title = banner
    ? banner.title
    : `Free delivery on orders over ${formatPrice(threshold!)}`;
  const subtitle = banner?.subtitle || null;
  const imageUrl = banner?.imageUrl || null;
  const label = banner?.ctaLabel || "Shop Now";
  const href =
    banner?.ctaHref && isSafeLinkTarget(banner.ctaHref) ? banner.ctaHref : null;
  const endsAt = banner?.endsAt ? new Date(banner.endsAt).getTime() : null;

  return (
    <div
      role="region"
      aria-label="Announcement Bar"
      className="relative z-50 overflow-hidden bg-zinc-950 px-4 lg:py-4 py-2 text-zinc-100 border-b border-zinc-800/80 shadow-md print:hidden"
    >
      {/* Background Image Overlay with Fallback Gradient */}
      {imageUrl ? (
        <div className="pointer-events-none absolute inset-0 z-0 opacity-20">
          <Image
            src={imageUrl}
            alt="Banner background"
            fill
            priority
            className="object-cover object-center blur-xs"
          />
        </div>
      ) : (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-amber-500/15 via-rose-500/15 to-indigo-500/15 opacity-70"
        />
      )}

      {/* Main Container */}
      <div className="relative z-10 mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-4 gap-y-2 text-center text-xs font-medium sm:text-sm">
        {/* Dynamic Badge */}
        <span className="inline-flex items-center rounded-full bg-amber-400/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300 ring-1 ring-inset ring-amber-400/30 uppercase tracking-wider">
          Limited Offer
        </span>

        {/* Content Group */}
        <div className="hidden md:flex flex-wrap items-center justify-center gap-x-2">
          <span className="font-bold tracking-tight text-white">{title}</span>

          {subtitle && (
            <>
              <span className="hidden text-zinc-500 sm:inline">•</span>
              <span className="text-zinc-300 font-normal">{subtitle}</span>
            </>
          )}
        </div>

        {/* Dynamic Expiry Timer Hint (If endsAt exists) */}
        {endsAt && (
          <span className="hidden md:inline-flex items-center text-[11px] text-rose-300 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
            Ends soon
          </span>
        )}

        {/* Action Button */}
        {href && (
          <Link
            href={href}
            className="group inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1 text-xs font-bold text-zinc-950 transition-all hover:bg-amber-300 hover:scale-[1.03] active:scale-95 shadow-sm"
          >
            <span>{label}</span>
            <svg
              className="h-3 w-3 transition-transform group-hover:translate-x-1"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"
              />
            </svg>
          </Link>
        )}
      </div>
    </div>
  );
}
