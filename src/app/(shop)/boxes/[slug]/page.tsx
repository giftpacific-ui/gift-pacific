import type { Metadata } from "next";
import { firstText, noIndexMetadata } from "@/lib/seo";
import { pageMetadata } from "@/server/services/seo.service";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site";
import { getActiveBoxBySlug } from "@/server/services/box.service";
import { keywordsForMetadata } from "@/lib/seo-keywords";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/utils";
import { CardAddToCartButton } from "@/features/products/card-add-to-cart-button";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const box = await getActiveBoxBySlug(slug);
  if (!box) return noIndexMetadata("Box not found");
  const customTitle = firstText(box.seoTitle);
  return pageMetadata({
    title: customTitle || box.name,
    titleIsCustom: !!customTitle,
    description: firstText(box.seoDescription, box.description) || `${box.name} gift box from ${siteConfig.name}.`,
    path: `/boxes/${box.slug}`,
    image: box.imageUrl,
    imageAlt: box.name,
    keywords: keywordsForMetadata(box.seoKeywords),
  });
}

export default async function BoxDetailPage({ params }: Props) {
  const { slug } = await params;
  const box = await getActiveBoxBySlug(slug); // inactive boxes 404 here
  if (!box) notFound();
  return (
    <div className="container-boutique grid gap-10 px-4 py-16 sm:px-6 md:grid-cols-2">
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-secondary">
        {box.imageUrl && <Image src={box.imageUrl} alt={box.name} fill priority sizes="(min-width:768px) 50vw, 100vw" className="object-cover" />}
      </div>
      <div className="space-y-4">
        <h1 className="font-heading text-3xl font-semibold">{box.name}</h1>
        <p className="text-lg">{formatPrice(box.price)}</p>
        {box.description && <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{box.description}</p>}
        <div className="flex flex-wrap gap-3 pt-2">
          {box.productId && box.inStock ? (
            <div className="w-48"><CardAddToCartButton productId={box.productId} name={box.name} price={box.price} currency="BDT" /></div>
          ) : (
            <Button disabled>{box.productId ? "Out of stock" : "Not available to order"}</Button>
          )}
          <Button asChild variant="outline"><Link href="/build-your-own-combo">Build your own combo</Link></Button>
        </div>
      </div>
    </div>
  );
}
