import Link from "next/link";
import { Star } from "lucide-react";
import type { FeaturedReview } from "@/server/services/review.service";
import { Reveal } from "@/components/shared/reveal";

/**
 * Real customer reviews — approved in Admin → Reviews, written by customers
 * who received the product. Renders NOTHING when there are none: we never
 * show made-up testimonials.
 */
export function CustomerReviews({ reviews }: { reviews: FeaturedReview[] }) {
  if (reviews.length === 0) return null;
  return (
    <section className="bg-secondary">
      <div
        className="container-boutique section-y"
        aria-labelledby="reviews-heading"
      >
        <Reveal>
          <div className="mb-10 text-center sm:mb-14">
            <p className="eyebrow justify-center">Kind words</p>
            <h2
              id="reviews-heading"
              className="font-heading text-[clamp(1.9rem,3.6vw,2.9rem)] leading-tight font-semibold"
            >
              Loved by our customers
            </h2>
          </div>
          <ul className="mx-auto grid max-w-5xl gap-10 md:grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]">
            {reviews.map((r, i) => (
              <li key={i}>
                <figure className="flex h-full flex-col">
                  <div
                    className="flex gap-0.5 text-primary"
                    role="img"
                    aria-label={`${r.rating} out of 5 stars`}
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star
                        key={n}
                        className={`size-4 ${n <= r.rating ? "fill-current" : ""}`}
                        aria-hidden
                      />
                    ))}
                  </div>
                  <blockquote className="mt-4 flex-1 font-heading text-[1.35rem] leading-snug font-medium text-balance">
                    &ldquo;{r.body}&rdquo;
                  </blockquote>
                  <figcaption className="mt-4 text-sm text-muted-foreground">
                    {r.reviewerName} on{" "}
                    <Link
                      href={`/products/${r.productSlug}`}
                      className="underline underline-offset-4 transition-colors hover:text-primary"
                    >
                      {r.productName}
                    </Link>
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
