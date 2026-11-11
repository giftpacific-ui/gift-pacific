/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type HeroSlide = {
  title: string;
  subtitle: string | null;
  ctaLabel: string;
  ctaHref: string;
  imageUrl: string | null;
  imageAlt: string;
};

export type HeroSpotlight = { name: string; slug: string; imageUrl: string };

const SLIDE_MS = 6000;

export function Hero({
  slides,
  storeName,
}: {
  slides: HeroSlide[];
  spotlight: HeroSpotlight | null;
  storeName: string;
}) {
  // Fallback default slide if admin hasn't added any banners yet
  const effectiveSlides: HeroSlide[] =
    slides.length > 0
      ? slides
      : [
          {
            title: "Gifts shaped by hand, given from the heart",
            subtitle:
              "Discover our exclusive handmade collection curated for your special moments.",
            ctaLabel: "Shop Collection",
            ctaHref: "/shop",
            imageUrl: null,
            imageAlt: storeName,
          },
        ];

  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const autoplay =
    effectiveSlides.length > 1 && !paused && !interacting && !reducedMotion;
  useEffect(() => {
    if (!autoplay) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % effectiveSlides.length),
      SLIDE_MS,
    );
    return () => clearInterval(id);
  }, [autoplay, effectiveSlides.length]);

  const currentSlide = effectiveSlides[index] ?? effectiveSlides[0];

  const handlePrev = () => {
    setIndex((i) => (i - 1 + effectiveSlides.length) % effectiveSlides.length);
  };

  const handleNext = () => {
    setIndex((i) => (i + 1) % effectiveSlides.length);
  };

  return (
    <section
      className="relative overflow-hidden bg-secondary border-b border-border/40"
      aria-roledescription={effectiveSlides.length > 1 ? "carousel" : undefined}
      aria-label="Hero Banner"
      onMouseEnter={() => setInteracting(true)}
      onMouseLeave={() => setInteracting(false)}
      onFocusCapture={() => setInteracting(true)}
      onBlurCapture={() => setInteracting(false)}
    >
      <div className="container-boutique relative min-h-[520px] lg:min-h-[600px] py-12 lg:py-20 flex items-center">
        <div className="grid w-full items-center gap-12 lg:grid-cols-2 lg:gap-16">
          {/* Left Content Area */}
          <div className="space-y-6 text-left z-10 order-2 lg:order-1">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary text-background text-xs font-semibold tracking-wider uppercase">
              <span>{storeName} Exclusive</span>
            </div>

            <div className="space-y-4">
              <h1 className="font-heading text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-primary leading-[1.1] text-balance">
                {currentSlide.title}
              </h1>
              {currentSlide.subtitle && (
                <p className="text-lg text-muted-foreground max-w-lg leading-relaxed">
                  {currentSlide.subtitle}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-2">
              <Button
                asChild
                size="lg"
                className="rounded-full px-8 h-12 text-base shadow-sm"
              >
                <Link href={currentSlide.ctaHref || "/shop"}>
                  {currentSlide.ctaLabel || "Explore Now"}
                  <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
            </div>
          </div>

          {/* Right Image / Showcase Area */}
          <div className="relative flex justify-center lg:justify-end order-1 lg:order-2">
            <div className="relative w-full max-w-[500px] aspect-[4/3] sm:aspect-[16/10] lg:aspect-square rounded-3xl overflow-hidden shadow-xl bg-muted border border-border/50">
              {currentSlide.imageUrl ? (
                <Image
                  src={currentSlide.imageUrl}
                  alt={currentSlide.imageAlt || "Banner image"}
                  fill
                  priority={index === 0}
                  sizes="(min-width: 1024px) 500px, 90vw"
                  className="object-cover transition-transform duration-700 hover:scale-105"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-primary/5 to-primary/10 p-6 text-center">
                  <span className="font-heading text-6xl font-bold text-primary/30">
                    {storeName.charAt(0)}
                  </span>
                  <p className="text-sm text-muted-foreground mt-2">
                    {storeName} Signature Collection
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Slider Controls & Navigation Indicators */}
      {effectiveSlides.length > 1 && (
        <div className="absolute lg:bottom-6 bottom-13 left-0 right-0 container-boutique flex items-center lg:justify-between justify-end pointer-events-none">
          <div className="flex items-center gap-2 pointer-events-auto bg-background/80 backdrop-blur-md border border-border/50 px-3 py-1.5 rounded-full shadow-sm">
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              aria-label={
                paused || reducedMotion
                  ? "Start slide rotation"
                  : "Pause slide rotation"
              }
              className="size-7 cursor-pointer flex items-center justify-center rounded-full hover:bg-muted text-foreground transition-colors"
            >
              {paused || reducedMotion ? (
                <Play className="size-3.5" />
              ) : (
                <Pause className="size-3.5" />
              )}
            </button>
            <div className="h-4 w-px bg-border mx-1" />
            <div className="flex gap-1.5 px-1">
              {effectiveSlides.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-label={`Go to slide ${i + 1}`}
                  className={cn(
                    "h-2 cursor-pointer rounded-full transition-all duration-300",
                    i === index
                      ? "w-6 bg-primary"
                      : "w-2 bg-border hover:bg-muted-foreground/50",
                  )}
                />
              ))}
            </div>
          </div>

          <div className="hidden  sm:flex items-center gap-2 pointer-events-auto">
            <button
              onClick={handlePrev}
              aria-label="Previous slide"
              className="cursor-pointer size-9 rounded-full bg-background/80 backdrop-blur-md border border-border/50 flex items-center justify-center shadow-sm hover:bg-background transition-colors text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              onClick={handleNext}
              aria-label="Next slide"
              className="cursor-pointer size-9 rounded-full bg-background/80 backdrop-blur-md border border-border/50 flex items-center justify-center shadow-sm hover:bg-background transition-colors text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
