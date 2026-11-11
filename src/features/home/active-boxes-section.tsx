import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Gift } from "lucide-react";
import { Reveal } from "@/components/shared/reveal";
import { PublicBox } from "@/server/services/box.service";



interface ActiveBoxesSectionProps {
  boxes: PublicBox[];
}

export function ActiveBoxesSection({ boxes }: ActiveBoxesSectionProps) {
  if (!boxes || boxes.length === 0) return null;

  return (
    <section className="border-y border-border bg-secondary/30">
      <Reveal className="container-boutique section-y">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-3 sm:mb-12">
          <div>
            <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium tracking-wide text-primary uppercase">
              <Gift className="h-4 w-4" />
              <span>Signature Collection</span>
            </div>
            <h2 className="font-heading text-[clamp(1.9rem,3.6vw,2.9rem)] leading-tight font-semibold">
              Our Gift Boxes
            </h2>
            <p className="mt-2 max-w-xl text-muted-foreground">
              সুন্দর ডিজাইনের কাস্টম বক্স, প্রিয়জনকে ভালোবাসা জানানোর জন্য সেরা
              উপহার।
            </p>
          </div>
          <Link href="/boxes" className="link-underline text-sm font-medium">
            View all boxes{" "}
            <ArrowRight className="inline-block size-4" aria-hidden />
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
          {boxes.map((box) => (
            <div
              key={box.id}
              className="group relative flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-background transition-all duration-300 hover:shadow-lg hover:-translate-y-1"
            >
              <Link
                href={`/boxes/${box.slug}`}
                className="relative aspect-square w-full overflow-hidden bg-muted"
              >
                {box.imageUrl ? (
                  <Image
                    src={box.imageUrl}
                    alt={box.name}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                    sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 25vw"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-secondary text-muted-foreground">
                    <Gift className="h-10 w-10 opacity-40" />
                  </div>
                )}

                {!box.inStock && (
                  <span className="absolute top-3 right-3 rounded-full bg-destructive/90 px-3 py-1 text-[11px] font-medium text-destructive-foreground backdrop-blur-md">
                    Out of Stock
                  </span>
                )}
              </Link>

              <div className="flex flex-1 flex-col justify-between p-5">
                <div>
                  <h3 className="font-heading text-lg font-medium text-foreground">
                    <Link
                      href={`/boxes/${box.slug}`}
                      className="hover:text-primary transition-colors"
                    >
                      {box.name}
                    </Link>
                  </h3>
                  {box.description && (
                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {box.description}
                    </p>
                  )}
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-border/50 pt-4">
                  <span className="font-heading text-base font-semibold text-foreground">
                    ৳ {box.price.toLocaleString()}
                  </span>

                  <Link
                    href={`/boxes/${box.slug}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-4 py-2 text-xs font-medium text-secondary-foreground transition hover:bg-primary hover:text-primary-foreground"
                  >
                    <span>View Box</span>
                    <ArrowRight className="size-3.5" />
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
