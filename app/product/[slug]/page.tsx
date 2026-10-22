import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { products } from "@/data/products";
import { formatPrice } from "@/lib/utils";
import ProductDetailActions from "./ProductDetailActions";
import ProductCard from "@/components/ProductCard";
import { CheckCircle2, ArrowLeft, Sparkles, XCircle } from "lucide-react";
import TrackPageEvent from "@/components/TrackPageEvent";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return products.map((p) => ({
    slug: p.slug,
  }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = products.find((p) => p.slug === slug);

  if (!product) {
    return {
      title: "প্রোডাক্ট পাওয়া যায়নি — Gift Pacific",
    };
  }

  const pageTitle = `${product.name} (${product.nameEnglish}) — Gift Pacific`;
  const pageDescription = `${product.desc} | ${product.descEnglish}`;

  return {
    title: pageTitle,
    description: pageDescription,
    keywords: [
      product.name,
      product.nameEnglish,
      "Gift Pacific",
      "Gift Box Bangladesh",
      "Online Gift Shop",
    ],
    openGraph: {
      title: pageTitle,
      description: pageDescription,
      images: [{ url: product.img }],
    },
  };
}

export default async function ProductDetailPage({ params }: Props) {
  const { slug } = await params;
  const product = products.find((p) => p.slug === slug);

  if (!product) {
    notFound();
  }

  const related = products
    .filter((p) => p.cat === product.cat && p.slug !== product.slug)
    .slice(0, 4);

  return (
    <main className="py-10">
      <TrackPageEvent
        eventName="ViewContent"
        data={{
          content_name: product.name,
          content_ids: [product.slug],
          content_type: "product",
          value: product.price,
          currency: "BDT",
        }}
      />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Breadcrumb Back Link */}
        <div className="mb-6">
          <Link
            href="/shop"
            className="inline-flex items-center gap-2 text-xs sm:text-sm font-semibold text-black hover:text-[#3a3f2b] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>শপ কালেকশনে ফিরে যান</span>
          </Link>
        </div>

        {/* Product Details Section */}
        <div className="bg-white rounded-3xl border border-[#e8dad5] p-6 sm:p-10 shadow-xs mb-16">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
            {/* Image Column */}
            <div className="lg:col-span-6">
              <div className="relative aspect-square w-full rounded-2xl overflow-hidden bg-[#f5ede8] border border-[#e8dad5] shadow-xs">
                <Image
                  src={product.img}
                  alt={product.name}
                  fill
                  priority
                  sizes="(max-width: 1024px) 100vw, 550px"
                  className={`object-cover ${!product.inStock ? "grayscale opacity-80" : ""}`}
                  referrerPolicy="no-referrer"
                />

                {/* Product Tags / Badges */}
                <div className="absolute top-4 left-4 flex flex-col gap-2">
                  {product.tag && (
                    <span className="px-3 py-1.5 text-xs font-bold rounded-lg bg-[#3a3f2b] text-white shadow-sm">
                      {product.tag}
                    </span>
                  )}
                  {!product.inStock && (
                    <span className="px-3 py-1.5 text-xs font-bold rounded-lg bg-red-600 text-white shadow-sm">
                      স্টক আউট (Out of Stock)
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Info Column */}
            <div className="lg:col-span-6 flex flex-col justify-between space-y-6">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="inline-block px-3 py-1 rounded-full bg-[#f5ede8] text-[#3a3f2b] text-xs font-semibold uppercase tracking-wider">
                    {product.cat === "combo"
                      ? "কম্বো গিফট বক্স"
                      : "একক উপহার উপাদান"}
                  </span>

                  {/* Availability Badge */}
                  <span
                    className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                      product.inStock
                        ? "bg-green-100 text-green-800"
                        : "bg-red-100 text-red-800"
                    }`}
                  >
                    {product.inStock ? "ইন স্টক" : "স্টক আউট"}
                  </span>
                </div>

                <h1 className="text-3xl sm:text-4xl font-extrabold text-[#3a3f2b] tracking-tight">
                  {product.name}
                </h1>

                {/* Price Display */}
                <div className="flex items-baseline gap-3 my-4">
                  <span className="text-3xl font-extrabold text-[#3a3f2b]">
                    {formatPrice(product.price)}
                  </span>
                  {product.oldPrice && (
                    <span className="text-base line-through text-red-600">
                      {formatPrice(product.oldPrice)}
                    </span>
                  )}
                </div>

                <div className="h-px bg-[#e8dad5] my-4" />

                <h4 className="lg:text-2xl md:text-lg text-base text-black leading-relaxed">
                  {product.desc}
                </h4>
              </div>

              {/* Action Buttons (In Stock অনুযায়ী প্রসেস করবে) */}
              {product.inStock ? (
                <ProductDetailActions product={product} />
              ) : (
                <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl flex items-center gap-3">
                  <XCircle className="w-6 h-6 shrink-0" />
                  <div>
                    <p className="font-semibold text-sm">
                      দুঃখিত, এই পণ্যটি বর্তমানে স্টক আউট!
                    </p>
                    <p className="text-xs">
                      পণ্যটি আবার উপলব্ধ হলে দেখতে অর্ডার সেকশনে ফিরে আসুন।
                    </p>
                  </div>
                </div>
              )}

              {/* Detailed Description */}
              <div className="text-sm sm:text-base text-black leading-relaxed mb-6 space-y-3">
                {product.details.split("\n\n").map((paragraph, index) => (
                  <p key={index} className="whitespace-pre-line">
                    {paragraph}
                  </p>
                ))}
              </div>

              {/* Quality Guarantees */}
              <div className="space-y-3 bg-[#fbf7f4] p-4 rounded-2xl border border-[#e8dad5] text-xs text-[#3a3f2b]">
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-[#3a3f2b] shrink-0" />
                  <span>
                    ক্যাশ অন ডেলিভারিতে সম্পূর্ণ সারা বাংলাদেশে ডেলিভারি
                  </span>
                </div>
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-[#3a3f2b] shrink-0" />
                  <span>
                    ১০০% প্রিমিয়াম ফিনিশিং, নিখুঁত হ্যান্ডমেড প্যাকেজিং
                  </span>
                </div>
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-[#3a3f2b] shrink-0" />
                  <span>
                    হাতে লেখা ব্যক্তিগত শুভেচ্ছা কার্ড যোগ করার সুবিধা
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Related Products */}
        {related.length > 0 && (
          <div className="pt-6">
            <div className="flex items-center justify-between mb-8">
              <div>
                <span className="text-xs font-bold text-[#3a3f2b] uppercase tracking-wider">
                  You Might Also Like
                </span>
                <h2 className="text-2xl font-bold text-[#3a3f2b] mt-1 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-[#3a3f2b]" />
                  <span>আরও পছন্দসই উপহার</span>
                </h2>
              </div>
              <Link
                href="/shop"
                className="text-xs sm:text-sm font-semibold text-[#3a3f2b] hover:underline"
              >
                সব দেখুন →
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {related.map((item) => (
                <ProductCard key={item.slug} product={item} />
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
