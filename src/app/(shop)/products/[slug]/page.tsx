import { schemaAvailability } from "@/lib/seo-availability";
import { keywordsForMetadata } from "@/lib/seo-keywords";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { buildPageMetadata, firstText, noIndexMetadata, productPath, categoryPath, clampText } from "@/lib/seo";
import { breadcrumbJsonLd, productJsonLd } from "@/lib/structured-data";
import { JsonLd } from "@/components/seo/json-ld";
import { resolveProductRedirect } from "@/server/services/slug-redirect.service";
import {
    getProductBySlug,
    getProductSeo,
    getProductStockPolicy,
  getRelatedProducts,
  getFrequentlyBoughtTogether,
  getCategoryBreadcrumb,
} from "@/server/services/product.service";
import { ProductGallery } from "@/features/products/product-gallery";
import { AddToCartForm } from "@/features/products/add-to-cart-form";
import { getProductSpecifications } from "@/server/services/attribute.service";
import { ComboBuilder } from "@/features/products/combo-builder";
import { ProductSection } from "@/features/home/product-section";
import { RecordAndShowRecentlyViewed } from "@/features/products/recently-viewed-section";
import { TrackProductView } from "@/features/products/track-product-view";
import { WishlistButton } from "@/features/wishlist/wishlist-button";
import { Banknote, Star, Undo2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Link from "next/link";
import { ReviewForm } from "@/features/products/review-form";
import { ProductReviewsList } from "@/features/products/product-reviews-list";
import { ProductQuestions } from "@/features/products/product-questions";
import { getApprovedQuestions } from "@/server/services/question.service";
import { getYouTubeGalleryEmbedUrl } from "@/utils/GetYoutubeUrl";

const badgeLabels: Record<string, string> = {
  NEW: "New",
  BEST_SELLER: "Best Seller",
  LIMITED_EDITION: "Limited Edition",
  HANDMADE: "Handmade",
  PERSONALIZED: "Personalized",
  SALE: "Sale",
};

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  // getProductBySlug / getProductSeo are request-cached, so the page below reuses these exact queries.
  const [data, seo] = await Promise.all([getProductBySlug(slug), getProductSeo(slug)]);
  if (!data) return noIndexMetadata("Product not found");
  const { product } = data;
  const customTitle = firstText(seo?.metaTitle);
  const main = product.images[0];
  return buildPageMetadata({
    title: customTitle || product.name,
    titleIsCustom: !!customTitle,
    // Fallback order: SEO description → short description → start of the full description.
    description: firstText(seo?.metaDescription, product.shortDescription, product.description),
    path: productPath(product.slug),
    image: seo?.seoImage || main?.url,
    imageAlt: main?.altText || product.name,
    keywords: keywordsForMetadata(seo?.metaKeywords),
    // Admin switch, and a box's hidden backing product (its public page is /boxes/<slug>).
    noindex: !!seo?.seoNoIndex || !!seo?.isBoxProduct,
  });
}

export default async function ProductDetailPage({ params }: Props) {
  const { slug } = await params;
  const data = await getProductBySlug(slug);
  if (!data) {
    // A retired slug of an active product → permanent redirect to the current URL; anything else is a real 404.
    const current = await resolveProductRedirect(slug);
    if (current) permanentRedirect(productPath(current));
    notFound();
  }
  const { product, categoryId, reviews } = data;
  const [stockPolicy, specifications, seo, questions] = await Promise.all([
    getProductStockPolicy(slug),
    getProductSpecifications(product.id),
    getProductSeo(slug),
    getApprovedQuestions(product.id),
  ]);


  const related = await getRelatedProducts(product.id, categoryId);
  const frequentlyBoughtTogether = await getFrequentlyBoughtTogether(
    product.id,
    categoryId,
  );
  const breadcrumb = categoryId ? await getCategoryBreadcrumb(categoryId) : [];
  const averageRating =
    reviews.length > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : null;

  const variantPrices = product.variants.map((v) => v.price);
  const structuredData = [
    productJsonLd({
      name: product.name,
      description: clampText(firstText(product.shortDescription, product.description), 500),
      path: productPath(product.slug),
      images: product.images.map((i) => i.url),
      sku: product.sku,
      brand: seo?.brand,
      currency: product.currency,
      price: product.price,
      highPrice: product.type === "VARIANT" && variantPrices.length > 1 ? Math.max(...variantPrices) : null,
      offerCount: product.type === "VARIANT" ? variantPrices.length : null,
      availability: schemaAvailability(
        stockPolicy ?? { trackInventory: true, allowBackorder: false, type: "STANDARD", stock: 0, variants: [] },
        product.availability.inStock,
      ),
      reviews,
    }),
    breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Shop", path: "/shop" },
      ...breadcrumb.map((c) => ({ name: c.name, path: categoryPath(c.slug) })),
      { name: product.name, path: productPath(product.slug) },
    ]),
  ];

  const embedVideoUrl = getYouTubeGalleryEmbedUrl(product.videoUrl);

  const stockNote = !product.availability.inStock ? "Currently out of stock" : null;

  return (
    <>
      <JsonLd data={structuredData} />
      <TrackProductView id={product.id} name={product.name} price={product.price} currency={product.currency} />

      <div className="container-boutique pt-6 pb-12 lg:pb-20">
        <nav aria-label="Breadcrumb" className="mb-6 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-primary">Home</Link>
          <span aria-hidden>/</span>
          <Link href="/shop" className="hover:text-primary">Shop</Link>
          {breadcrumb.map((crumb) => (
            <span key={crumb.id} className="flex items-center gap-1.5">
              <span aria-hidden>/</span>
              <Link href={`/shop/${crumb.slug}`} className="hover:text-primary">{crumb.name}</Link>
            </span>
          ))}
          <span aria-hidden>/</span>
          <span className="text-foreground" aria-current="page">{product.name}</span>
        </nav>

        <div className="grid gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:items-start lg:gap-20">
          <ProductGallery images={product.images} productName={product.name} videoUrl={product.videoUrl} />

          <div className="lg:sticky lg:top-28">
            <div className="flex items-start justify-between gap-4">
              <div>
                {product.category && (
                  <p className="mb-2 text-sm font-semibold tracking-wide text-primary">{product.category.name}</p>
                )}
                <h1 className="font-heading text-[clamp(1.9rem,3.4vw,2.7rem)] leading-tight font-semibold">{product.name}</h1>
              </div>
              <WishlistButton productId={product.id} />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              {averageRating !== null && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="img" aria-label={`Rated ${averageRating.toFixed(1)} out of 5 from ${reviews.length} review${reviews.length === 1 ? "" : "s"}`}>
                  <span className="flex gap-0.5 text-primary" aria-hidden>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star key={n} className={`size-4 ${n <= Math.round(averageRating) ? "fill-current" : ""}`} />
                    ))}
                  </span>
                  <span aria-hidden>{averageRating.toFixed(1)} · {reviews.length} review{reviews.length === 1 ? "" : "s"}</span>
                </div>
              )}
              {product.badges.map((badge) => (
                <span key={badge} className="rounded-[2px] bg-foreground px-2 py-0.5 text-[0.7rem] font-semibold tracking-wide text-background">
                  {badgeLabels[badge] ?? badge}
                </span>
              ))}
              {stockNote && <span className="text-sm font-medium text-destructive">{stockNote}</span>}
            </div>

            {product.shortDescription && <p className="mt-5 max-w-lg text-muted-foreground">{product.shortDescription}</p>}

            <div className="mt-6 border-t border-border pt-6">
              {product.combo ? <ComboBuilder product={product} /> : <AddToCartForm product={product} />}
            </div>

            <ul className="mt-7 grid border-y border-border text-sm sm:grid-cols-2">
              <li className="flex items-center gap-3 px-1 py-4">
                <Banknote className="size-5 shrink-0 text-primary" aria-hidden />
                <span>Pay on delivery</span>
              </li>
              <li className="flex items-center gap-3 border-t border-border px-1 py-4 sm:border-t-0 sm:border-l sm:pl-5">
                <Undo2 className="size-5 shrink-0 text-primary" aria-hidden />
                <Link href="/shipping-returns" className="underline-offset-4 hover:text-primary hover:underline">Shipping &amp; returns policy</Link>
              </li>
            </ul>

            {product.type === "BUNDLE" && product.bundleComponents.length > 0 && (
              <div className="mt-8 space-y-2 rounded-[4px] border border-border bg-card p-5">
                <p className="font-heading text-xl font-semibold">This gift box includes</p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {product.bundleComponents.map((item, index) => (
                    <li key={`${item.name}-${index}`}>
                      {item.quantity}× {item.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {product.sku && <p className="mt-6 text-xs text-muted-foreground">SKU: {product.sku}</p>}
          </div>
        </div>

        <Tabs defaultValue="description" className="mt-16 lg:mt-24">
          <TabsList className="h-auto w-full justify-start gap-6 overflow-x-auto rounded-none border-b border-border bg-transparent p-0">
            {[
              ["description", "Description"],
              ...(embedVideoUrl ? [["video", "Product video"]] : []),
              ["shipping", "Shipping & returns"],
              ["reviews", `Reviews (${reviews.length})`],
              ["questions", `Questions (${questions.length})`],
            ].map(([value, label]) => (
              <TabsTrigger
                key={value}
                value={value}
                className="-mb-px h-auto rounded-none border-0 border-b-2 border-transparent bg-transparent px-0 py-3 text-[0.95rem] font-semibold whitespace-nowrap shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent
            value="description"
            className="mt-8 max-w-2xl text-[0.97rem] leading-relaxed text-foreground/90 [&_a]:text-primary [&_a]:underline [&_h3]:mt-5 [&_h3]:mb-1 [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
            dangerouslySetInnerHTML={{ __html: product.description }}
          />
          {embedVideoUrl && (
            <TabsContent value="video" className="mt-8">
              <div className="relative aspect-video w-full max-w-2xl overflow-hidden rounded-[4px] border border-border">
                <iframe
                  src={embedVideoUrl}
                  title={`${product.name} video`}
                  className="absolute inset-0 h-full w-full"
                  loading="lazy"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </TabsContent>
          )}
          <TabsContent value="shipping" className="mt-8 max-w-2xl text-[0.97rem] leading-relaxed text-foreground/90">
            {/* One source of truth: the policy page. (This tab used to hard-code
                shipping times and a return window that contradicted it.) */}
            <p>
              Delivery times, delivery charges and our returns &amp; exchanges policy — including how personalized and
              made-to-order items are handled — are set out on one page, so they&apos;re always up to date.
            </p>
            <p className="mt-4">
              <Link href="/shipping-returns" className="link-underline">
                Read the shipping &amp; returns policy
              </Link>
            </p>
          </TabsContent>
          <TabsContent value="reviews" className="mt-8 max-w-2xl space-y-5">
            <ProductReviewsList reviews={reviews} />
            <ReviewForm productId={product.id} />
          </TabsContent>
          <TabsContent value="questions" className="mt-8 max-w-2xl space-y-5">
            <ProductQuestions productId={product.id} questions={questions} />
          </TabsContent>
        </Tabs>
        {specifications.length > 0 && (
          <section aria-labelledby="specs-heading" className="mt-12 max-w-2xl space-y-6">
            <h2 id="specs-heading" className="font-heading text-2xl font-semibold">Specifications</h2>
            {specifications.map((group) => (
              <div key={group.group} className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group.group}</h3>
                <dl className="divide-y divide-border rounded-[4px] border border-border">
                  {group.items.map((item) => (
                    <div key={item.name} className="grid grid-cols-3 gap-4 px-4 py-2.5 text-sm">
                      <dt className="text-muted-foreground">{item.name}</dt>
                      <dd className="col-span-2">{item.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </section>
        )}
      </div>

      <ProductSection eyebrow="Pairs well" title="Frequently bought together" products={frequentlyBoughtTogether} />
      <ProductSection tone="sand" eyebrow="More to love" title="You may also like" products={related} />
      <div className="container-boutique">
        <RecordAndShowRecentlyViewed productId={product.id} />
      </div>
    </>
  );
}
