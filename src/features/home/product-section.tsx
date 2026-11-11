import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { PublicProductCard } from "@/lib/product-dto";
import { ProductCard } from "@/features/products/product-card";
import { Reveal } from "@/components/shared/reveal";
import { cn } from "@/lib/utils";

/**
 * A titled row of real, database-backed products. `stagger` offsets every
 * second card on large screens for the editorial rhythm; `indexed` adds the
 * "01 — Category" rule above each card.
 */
export function ProductSection({
  eyebrow,
  title,
  subtitle,
  viewAllHref,
  viewAllLabel = "View all",
  products,
  stagger = false,
  indexed = false,
  tone = "plain",
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  viewAllHref?: string;
  viewAllLabel?: string;
  products: PublicProductCard[];
  stagger?: boolean;
  indexed?: boolean;
  tone?: "plain" | "sand";
}) {
  if (products.length === 0) return null;
  const headingId = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <section aria-labelledby={headingId} className={cn(tone === "sand" && "border-y border-border bg-background")}>
      <Reveal className="container-boutique section-y">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-3 sm:mb-12">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id={headingId} className="font-heading text-[clamp(1.9rem,3.6vw,2.9rem)] leading-tight font-semibold">
              {title}
            </h2>
            {subtitle && <p className="mt-2 max-w-xl text-muted-foreground">{subtitle}</p>}
          </div>
          {viewAllHref && (
            <Link href={viewAllHref} className="link-underline text-sm">
              {viewAllLabel} <ArrowRight className="size-4" aria-hidden />
            </Link>
          )}
        </div>
        <div
          className={cn(
            "grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-4 lg:gap-x-6 lg:gap-y-14",
            stagger && "lg:[&>*:nth-child(even)]:mt-10",
          )}
        >
          {products.map((product, i) => (
            <ProductCard key={product.id} product={product} index={indexed ? i : undefined} />
          ))}
        </div>
      </Reveal>
    </section>
  );
}
