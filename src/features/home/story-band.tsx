import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Reveal } from "@/components/shared/reveal";
import { siteConfig } from "@/config/site";

/**
 * "Our story" teaser. The wording is the store's own About-page copy (not
 * invented here), and — unlike the design reference — carries NO made-up
 * statistics, order counts, years or ratings. The photograph is a real product
 * photo when one is available; otherwise the text stands alone.
 */
export function StoryBand({
  imageUrl,
  imageCaption,
}: {
  imageUrl: string | null;
  imageCaption: string | null;
}) {
  return (
    <section
      className="border-y border-border bg-secondary"
      aria-labelledby="story-heading"
    >
      <Reveal className="container-boutique section-y grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
        <div>
          <p className="eyebrow">Our story</p>
          <h2
            id="story-heading"
            className="font-heading text-[clamp(1.9rem,3.6vw,2.9rem)] leading-tight font-semibold"
          >
            Handmade, with care &amp; passion
          </h2>
          <p className="mt-5 max-w-lg text-muted-foreground">
            {siteConfig.name} started with a simple idea: gifts feel more
            meaningful when someone actually made them.
          </p>
          <Link href="/about-us" className="link-underline mt-7 text-sm">
            Read our story <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>

        {imageUrl && (
          <figure className="justify-self-center lg:justify-self-end">
            <div className="w-[min(100%,26rem)] rotate-[1.2deg] border border-border bg-background p-2 pb-3 shadow-[0_18px_40px_-18px_rgba(38,23,34,0.35)]">
              <div className="relative aspect-[5/6] overflow-hidden bg-secondary">
                <Image
                  src={imageUrl}
                  alt={imageCaption ?? ""}
                  fill
                  sizes="(min-width: 1024px) 26rem, 90vw"
                  className="product-image-tone object-cover"
                />
              </div>
              {imageCaption && (
                <figcaption className="mt-2 text-xs text-muted-foreground">
                  {imageCaption}
                </figcaption>
              )}
            </div>
          </figure>
        )}
      </Reveal>
    </section>
  );
}
