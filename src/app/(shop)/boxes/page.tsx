import type { Metadata } from "next";
import { pageMetadata } from "@/server/services/seo.service";
import Image from "next/image";
import Link from "next/link";
import { siteConfig } from "@/config/site";
import { getActiveBoxes } from "@/server/services/box.service";
import { formatPrice } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({ title: "Gift boxes", description: `Ready-made gift boxes from ${siteConfig.name}, packed and delivered across Bangladesh.`, path: "/boxes" });
}
export const revalidate = 300; // admin saves also revalidate this path

export default async function BoxesPage() {
  const boxes = await getActiveBoxes();
  return (
    <div className="container-boutique space-y-10 px-4 py-16 sm:px-6">
      <header className="mx-auto max-w-2xl space-y-3 text-center">
        <h1 className="font-heading text-[clamp(2rem,4.5vw,3.2rem)] font-semibold">Our Boxes</h1>
        <p className="text-sm text-muted-foreground">Choose a box for your handmade gifts, or{" "}
          <Link href="/build-your-own-combo" className="underline underline-offset-4">build your own combo</Link>.</p>
      </header>
      {boxes.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground">Our boxes are being prepared. Please check back soon.</p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {boxes.map((b) => (
            <li key={b.id} className="overflow-hidden rounded-xl border border-border/70 bg-card">
              <Link href={`/boxes/${b.slug}`} className="block">
                <div className="relative aspect-[4/3] bg-secondary">
                  {b.imageUrl && <Image src={b.imageUrl} alt={b.name} fill sizes="(min-width:1024px) 33vw, (min-width:640px) 50vw, 100vw" className="object-cover" />}
                </div>
                <div className="space-y-1 p-4">
                  <h2 className="font-heading text-lg">{b.name}</h2>
                  <p className="text-sm text-muted-foreground">{formatPrice(b.price)}{b.productId && !b.inStock ? " · out of stock" : ""}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
