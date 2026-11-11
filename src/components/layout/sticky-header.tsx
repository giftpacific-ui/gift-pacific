"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Sticky, blurred header that gains a hairline border (and tightens) once the page scrolls. */
export function StickyHeader({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    // Sync the initial state (e.g. after a refresh part-way down the page).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      data-scrolled={scrolled}
      className={cn(
        "group sticky top-0 z-40 border-b bg-background/90 backdrop-blur-md transition-colors duration-300 print:hidden",
        scrolled ? "border-border" : "border-transparent",
      )}
    >
      {children}
    </header>
  );
}
