import { getPublishedSystemPage } from "@/server/services/static-page.service";
import { CmsSystemPage } from "@/components/layout/cms-system-page";
import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/server/services/seo.service";
import { siteConfig } from "@/config/site";
import { getPublishedTeam } from "@/server/services/team.service";
import { TeamSection } from "@/features/about/team-section";
import { Gift, Package, Banknote } from "lucide-react";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: "About us",
    description: `${siteConfig.name} is a gifting store for birthdays, anniversaries and everyday moments — gifts, gift boxes and custom combos.`,
    path: "/about-us",
  });
}

const points = [
  {
    icon: Gift,
    title: "Gifts for every occasion",
    text: "A curated range of gifts for birthdays, anniversaries, and everyday moments.",
  },
  {
    icon: Package,
    title: "Boxes & custom combos",
    text: "Choose a ready gift box or build your own combo from available items.",
  },
  {
    icon: Banknote,
    title: "Pay on delivery",
    text: "Order now and pay in cash when your parcel arrives.",
  },
];

export default async function AboutUsPage() {
  // Admin-published replacement content wins; until then the built-in page below keeps rendering.
  const cms = await getPublishedSystemPage("about-us");
  if (cms) return <CmsSystemPage page={cms} />;
  const team = await getPublishedTeam();
  return (
    <div className="container-boutique space-y-12 px-4 py-16 sm:px-6">
      <header className="mx-auto max-w-2xl space-y-3 text-center">
        <p className="eyebrow justify-center">About us</p>
        <h1 className="font-heading text-[clamp(2.2rem,4.5vw,3.4rem)] leading-tight font-semibold text-foreground">
          Gifting, made simple
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {siteConfig.name} is a gifting store that helps you find something
          thoughtful for the people who matter.
        </p>
      </header>

      <div className="mx-auto max-w-3xl space-y-8 rounded-[4px] border border-border bg-card p-8 shadow-xs sm:p-12">
        <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
          Whether it&apos;s a single present, a ready-made gift box, or a combo
          you put together yourself, we want choosing and sending a gift to feel
          easy. Where a product can be personalized, you&apos;ll see the options
          on its page.
        </p>

        <ul className="grid gap-4 border-t border-border/60 pt-6 sm:grid-cols-3">
          {points.map((p) => (
            <li
              key={p.title}
              className="space-y-2 rounded-[4px] border border-border/50 bg-secondary/40 p-5"
            >
              <p.icon className="size-5 text-primary" aria-hidden strokeWidth={1.5} />
              <h2 className="font-heading text-sm font-semibold text-foreground">{p.title}</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">{p.text}</p>
            </li>
          ))}
        </ul>

        <p className="text-center text-sm text-muted-foreground">
          Have a question?{" "}
          <Link href="/contact" className="underline underline-offset-4">
            Get in touch
          </Link>
          .
        </p>
      </div>

      <TeamSection title="Management" members={team.management} />
      <TeamSection title="Our Team" members={team.staff} />
    </div>
  );
}
