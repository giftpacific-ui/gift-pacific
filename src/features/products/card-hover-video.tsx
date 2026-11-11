"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hover-preview video for a product card. The iframe is only created on the
 * card's first hover/keyboard focus — previously every card with a video
 * loaded its YouTube iframe up-front, which made listing pages heavy.
 */
export function CardHoverVideo({ embedUrl, title }: { embedUrl: string; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const card = ref.current?.closest(".group");
    if (!card) return;
    // Touch devices have no hover — don't download video there at all.
    if (!window.matchMedia("(hover: hover)").matches) return;
    const activate = () => setActive(true);
    card.addEventListener("pointerenter", activate, { once: true });
    card.addEventListener("focusin", activate, { once: true });
    return () => {
      card.removeEventListener("pointerenter", activate);
      card.removeEventListener("focusin", activate);
    };
  }, []);

  return (
    <div ref={ref} className="absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100" aria-hidden>
      {active && (
        <iframe
          src={embedUrl}
          title={title}
          loading="lazy"
          tabIndex={-1}
          className="pointer-events-none h-full w-full scale-125 object-cover"
          allow="autoplay; encrypted-media"
        />
      )}
    </div>
  );
}
