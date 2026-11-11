"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Fades content up as it scrolls into view.
 *
 * Progressive by design: the server renders the content fully visible (so
 * no-JS visitors, crawlers and print see everything). Only AFTER hydration,
 * and only for content that is currently below the fold, is it hidden and
 * then revealed by an IntersectionObserver. Visitors who prefer reduced
 * motion never get the hidden state at all.
 */
export function Reveal({
  children,
  className,
  as: Tag = "div",
  delayMs = 0,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
  delayMs?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<"visible" | "hidden" | "in">("visible");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;

    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.9) return; // already on screen: leave it alone

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("hidden");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState("in");
          observer.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      style={state === "in" && delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
      className={cn(state === "hidden" && "reveal-hidden", state === "in" && "reveal-in", className)}
    >
      {children}
    </Tag>
  );
}
