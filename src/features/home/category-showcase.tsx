"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

type Category = {
  name: string;
  slug: string;
  imageUrl: string | null;
  parentId: string | null;
};

/**
 * Editorial category index: big serif rows that invert on hover/focus. On
 * devices with a real pointer, the category's photograph follows the cursor.
 * (Touch devices and reduced-motion visitors just get the rows.)
 */
export function CategoryShowcase({ categories }: { categories: Category[] }) {
  const floatRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [canFloat, setCanFloat] = useState(false);

  useEffect(() => {
    const fine = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    ).matches;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanFloat(fine && !calm);
  }, []);

  function onMove(e: React.MouseEvent) {
    if (floatRef.current)
      floatRef.current.style.transform = `translate(${e.clientX + 26}px, ${e.clientY - 110}px)`;
  }

  const parentCategories = categories.filter((c) => !c.parentId);


  return (
    <>
      <ul
        className="border-t border-border"
        onMouseMove={canFloat ? onMove : undefined}
        onMouseLeave={() => setActive(null)}
      >
        {parentCategories?.map((c, i) => (
          <li key={c.slug} className="border-b border-border">
            <Link
              href={`/shop/${c.slug}`}
              onMouseEnter={() => c.imageUrl && setActive(c.imageUrl)}
              onFocus={() => setActive(null)}
              className="group grid grid-cols-[auto_1fr_auto] items-center gap-4 px-2 py-5 transition-[background-color,color,padding] duration-300 hover:bg-primary hover:pl-5 hover:text-background focus-visible:bg-foreground focus-visible:pl-5 focus-visible:text-background sm:gap-8 sm:py-6"
            >
              <span className="min-w-8 text-sm text-muted-foreground transition-colors group-hover:text-secondary group-focus-visible:text-background/60">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="font-heading text-[clamp(1.5rem,3.4vw,2.4rem)] leading-tight font-semibold">
                {c.name}
              </span>
              <span className="grid size-11 place-items-center rounded-full border border-border transition-all duration-300 group-hover:border-primary group-hover:bg-secondary group-hover:text-primary group-focus-visible:border-primary group-focus-visible:bg-primary group-focus-visible:text-primary-foreground">
                <ArrowUpRight className="size-5" aria-hidden />
                <span className="sr-only">Shop {c.name}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {canFloat && (
        <div
          ref={floatRef}
          aria-hidden
          className="pointer-events-none fixed top-0 left-0 z-30"
        >
          <div
            className={`relative aspect-[4/5] w-52 -rotate-2 overflow-hidden rounded-[4px] bg-secondary shadow-[0_18px_40px_-18px_rgba(38,23,34,0.45)] transition-[opacity,transform] duration-300 ${
              active ? "scale-100 opacity-100" : "scale-90 opacity-0"
            }`}
          >
            {active && (
              <Image
                src={active}
                alt=""
                fill
                sizes="208px"
                className="product-image-tone object-cover"
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
