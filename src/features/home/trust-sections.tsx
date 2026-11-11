import { Banknote, Gift, Heart, Package } from "lucide-react";
import { Reveal } from "@/components/shared/reveal";
import { siteConfig } from "@/config/site";

// Every statement here must be true of THIS store as built: brand copy from
// the About page, plus the one payment method that actually exists.
const reasons = [
  {
    icon: Heart,
    title: "Handmade with care",
    description:
      "Every piece is shaped, glazed, and finished by hand in small batches.",
  },
  {
    icon: Gift,
    title: "Made to be personal",
    description:
      "Add names, dates, and messages to turn a piece into a keepsake.",
  },
  {
    icon: Banknote,
    title: "Pay on delivery",
    description:
      "Order now and pay in cash when your parcel arrives — nothing to pay online.",
  },
  {
    icon: Package,
    title: "Thoughtful packaging",
    description: "Gift-ready boxes and padding so everything arrives intact.",
  },
];

export function WhyChooseUs() {
  return (
    <section className="bg-background">
      <div
        className="container-boutique section-y"
        aria-labelledby="why-heading"
      >
        <Reveal>
          <div className="mb-10 text-center sm:mb-14">
            <p className="eyebrow justify-center">Why choose us</p>
            <h2
              id="why-heading"
              className="font-heading text-[clamp(1.9rem,3.6vw,2.9rem)] leading-tight font-semibold"
            >
              Why {siteConfig.name}
            </h2>
          </div>
          <ul className="grid grid-cols-1 gap-px overflow-hidden border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            {reasons.map((reason) => (
              <li
                key={reason.title}
                className="flex flex-col gap-3 bg-background p-7 sm:p-8"
              >
                <reason.icon
                  className="size-7 text-primary"
                  aria-hidden
                  strokeWidth={1.5}
                />
                <h3 className="font-heading text-xl font-semibold">
                  {reason.title}
                </h3>
                <p className="text-[0.95rem] text-muted-foreground">
                  {reason.description}
                </p>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
