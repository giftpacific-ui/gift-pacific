import type { Metadata } from "next";
import { pageMetadata } from "@/server/services/seo.service";
import Link from "next/link";
import { siteConfig } from "@/config/site";
import { prisma } from "@/lib/db/prisma";
import { getProductBySlug } from "@/server/services/product.service";
import { ComboBuilder } from "@/features/products/combo-builder";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({ title: "Build your own combo", description: `Pick your own gifts (and a box) and order your custom combo from ${siteConfig.name}.`, path: "/build-your-own-combo" });
}
export const revalidate = 60;

/**
 * Reuses the existing customizable-combo engine end to end: the SERVER re-validates every choice, decides the
 * price and deducts component stock. This page only lists the active customizable combos and renders the same
 * builder used on a product page; a "box" is simply a slot (e.g. "Choose a box") the admin adds to the combo.
 */
export default async function BuildYourOwnComboPage() {
  const combos = await prisma.product.findMany({
    where: { status: "ACTIVE", kind: "COMBO", comboMode: "CUSTOMIZABLE" },
    orderBy: { name: "asc" }, select: { slug: true }, take: 12,
  });
  const details = (await Promise.all(combos.map((c) => getProductBySlug(c.slug)))).filter((d) => d?.product.combo);

  return (
    <div className="container-boutique space-y-10 px-4 py-16 sm:px-6">
      <header className="mx-auto max-w-2xl space-y-3 text-center">
        <h1 className="font-heading text-[clamp(2rem,4.5vw,3.2rem)] font-semibold">Nije Combo Banan</h1>
        <p className="text-sm text-muted-foreground">Build your own combo: choose items for each step, review the price, then add it to your cart. You can also pick a ready-made{" "}
          <Link href="/shop?kind=combo" className="underline underline-offset-4">fixed combo</Link> or one of{" "}
          <Link href="/boxes" className="underline underline-offset-4">our boxes</Link>.</p>
      </header>
      {details.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground">Custom combos are not available right now. Please check back soon.</p>
      ) : (
        details.map((d) => (
          <section key={d!.product.id} aria-labelledby={`c-${d!.product.id}`} className="space-y-4 rounded-xl border border-border/70 bg-card p-5 sm:p-8">
            <h2 id={`c-${d!.product.id}`} className="font-heading text-2xl">{d!.product.name}</h2>
            <ComboBuilder product={d!.product} />
          </section>
        ))
      )}
    </div>
  );
}
