import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Reveal } from "@/components/shared/reveal";
import { siteConfig } from "@/config/site";

/**
 * "About us" teaser. Short, factual brand teaser with NO made-up
 * history, statistics, order counts, years or ratings. The photograph is a real product
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
          <p className="eyebrow">About us</p>
          <h2
            id="story-heading"
            className="font-heading text-[clamp(1.9rem,3.6vw,2.9rem)] leading-tight font-semibold"
          >
            Gifting, made simple
          </h2>
          <p className="mt-5 max-w-lg text-muted-foreground">
            {siteConfig.name} helps you find a thoughtful gift for the people
            who matter — from single items to gift boxes and custom combos.
          </p>
          <Link href="/about-us" className="link-underline mt-7 text-sm">
            About {siteConfig.name} <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>

        {imageUrl && (
          <figure className="justify-self-center lg:justify-self-end">
            <div className="w-[min(100%,26rem)] border border-border bg-background p-2 pb-3 shadow-[0_18px_40px_-18px_rgba(38,23,34,0.35)]">
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
