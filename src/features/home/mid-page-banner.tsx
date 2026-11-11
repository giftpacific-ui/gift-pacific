/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import React, { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import useEmblaCarousel from "embla-carousel-react";
import { Button } from "@/components/ui/button";
import type { getActiveBanners } from "@/server/services/product.service";

type Banner = Awaited<ReturnType<typeof getActiveBanners>>[number];

export function MidPageBanner({ banners }: { banners?: Banner[] }) {
  const slides = banners && banners.length > 0 ? banners : [];

  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollSnaps, setScrollSnaps] = useState<number[]>([]);

  const scrollTo = useCallback(
    (index: number) => emblaApi && emblaApi.scrollTo(index),
    [emblaApi],
  );

  const onSelect = useCallback(() => {
    if (!emblaApi) return;
    setSelectedIndex(emblaApi.selectedScrollSnap());
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    setScrollSnaps(emblaApi.scrollSnapList());
    onSelect();
    emblaApi.on("select", onSelect);
    emblaApi.on("reInit", onSelect);
  }, [emblaApi, onSelect]);

  // Auto-play feature (5 seconds)
  useEffect(() => {
    if (!emblaApi || slides.length <= 1) return;
    // Never auto-advance for visitors who prefer reduced motion.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const intervalId = setInterval(() => {
      emblaApi.scrollNext();
    }, 5000);

    return () => clearInterval(intervalId);
  }, [emblaApi, slides.length]);

  if (slides.length === 0) return null;

  return (
    <section className="container mx-auto px-3 section-y relative"
      aria-label="Promotions">
      {/* Embla Viewport */}
      <div
        className="overflow-hidden rounded-[4px] bg-secondary relative"
        ref={emblaRef}
      >
        <div className="flex touch-pan-y items-start">
          {slides.map((banner, index) => (
            <div
              key={banner.id || index}
              className="relative flex-[0_0_100%] min-w-0 select-none aspect-4/3 w-full sm:aspect-3/1"
            >
              <Image
                src={banner.imageUrl}
                alt=""
                fill
                sizes="100vw"
                className="product-image-tone object-cover"
              />
              <div className="absolute inset-0 flex flex-col items-start justify-center gap-3 bg-black/50 px-5 sm:px-14">
                <h2 className="max-w-md text-balance font-heading text-2xl text-white sm:text-4xl">
                  {banner.title}
                </h2>
                {banner.subtitle && (
                  <p className="max-w-sm text-balance text-sm text-white/90 sm:text-base">
                    {banner.subtitle}
                  </p>
                )}
                {banner.ctaHref && banner.ctaLabel && (
                  <Button asChild className="bg-secondary hover:bg-primary hover:text-white text-foreground">
                    <Link href={banner.ctaHref}>{banner.ctaLabel}</Link>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Slide Navigation & Controls (Only if multiple banners) */}
      {slides.length > 1 && (
        <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/40 px-3 py-1.5 backdrop-blur-md">
          {scrollSnaps.map((_, index) => (
            <button
              key={index}
              onClick={() => scrollTo(index)}
              aria-label={`Go to slide ${index + 1}`}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                index === selectedIndex
                  ? "w-6 bg-white"
                  : "w-1.5 bg-white/40 hover:bg-white/70"
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
