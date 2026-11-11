import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Closing call-to-action. Replaces the reference design's newsletter block:
 * there is no subscription backend, so instead of a form that only pretends
 * to sign people up, this points to the real contact page.
 */
export function HelpBand() {
  return (
    <section
      className="relative overflow-hidden bg-primary text-secondary"
      aria-labelledby="help-heading"
    >
      <div className="container-boutique relative z-[1] grid items-center gap-8 py-16 sm:py-20 lg:grid-cols-2">
        <div>
          <p className="mb-3 flex items-center gap-3 text-sm font-semibold tracking-wide text-gold before:h-px before:w-8 before:bg-current">
            Need a hand?
          </p>
          <h2
            id="help-heading"
            className="font-heading text-[clamp(1.9rem,3.6vw,2.9rem)] leading-tight font-semibold"
          >
            Not sure what to give?
          </h2>
          <p className="mt-3 max-w-md text-background/70">
            Tell us about the occasion and the person — we&apos;re happy to help
            you choose, or to talk through a personalized order.
          </p>
        </div>
        <div className="lg:justify-self-end">
          <Button
            asChild
            size="lg"
            className="h-13 bg-background px-7 text-foreground hover:bg-gold hover:text-foreground"
          >
            <Link href="/contact">
              Get in touch <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
