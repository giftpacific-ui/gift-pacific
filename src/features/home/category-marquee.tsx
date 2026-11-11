/**
 * Slow ticker of the store's REAL category names between the hero and the
 * content. Decorative (aria-hidden), pauses on hover, static for visitors who
 * prefer reduced motion. Renders nothing with fewer than two categories.
 */
export function CategoryMarquee({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  // Repeat enough that one half always overflows the viewport, then duplicate
  // the group for a seamless -50% loop.
  const reps = Math.max(1, Math.ceil(8 / names.length));
  const group = Array.from({ length: reps }, () => names).flat();
  const half = (
    <div className="flex shrink-0 items-center gap-10 pr-10">
      {group.map((name, i) => (
        <span key={i} className="flex items-center gap-10 whitespace-nowrap font-heading text-lg text-muted-foreground">
          {name}
          <i className="size-1.5 rotate-45 bg-primary" />
        </span>
      ))}
    </div>
  );
  return (
    <section aria-hidden className="marquee overflow-hidden border-y border-border py-4 bg-background">
      <div className="marquee-track flex w-max">
        {half}
        {half}
      </div>
    </section>
  );
}
