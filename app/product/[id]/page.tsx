import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { products } from '@/data/products';
import { formatPrice } from '@/lib/utils';
import ProductDetailActions from './ProductDetailActions';
import ProductCard from '@/components/ProductCard';
import { CheckCircle2, ArrowLeft, Sparkles } from 'lucide-react';
import TrackPageEvent from '@/components/TrackPageEvent';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateStaticParams() {
  return products.map((p) => ({
    id: String(p.id),
  }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const product = products.find((p) => p.id === Number(id));

  if (!product) {
    return {
      title: 'প্রোডাক্ট পাওয়া যায়নি — Gift Pacific',
    };
  }

  return {
    title: `${product.name} — Gift Pacific`,
    description: product.desc,
    openGraph: {
      title: `${product.name} — Gift Pacific`,
      description: product.desc,
      images: [{ url: product.img }],
    },
  };
}

export default async function ProductDetailPage({ params }: Props) {
  const { id } = await params;
  const product = products.find((p) => p.id === Number(id));

  if (!product) {
    notFound();
  }

  const related = products
    .filter((p) => p.cat === product.cat && p.id !== product.id)
    .slice(0, 4);

  return (
    <main className="py-10">
      <TrackPageEvent
        eventName="ViewContent"
        data={{
          content_name: product.name,
          content_ids: [product.id],
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
            className="inline-flex items-center gap-2 text-xs sm:text-sm font-semibold text-[#8a7a7a] hover:text-[#0053a8] transition-colors"
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
                  className="object-cover"
                  referrerPolicy="no-referrer"
                />
                {product.tag && (
                  <span className="absolute top-4 left-4 px-3 py-1.5 text-xs font-bold rounded-lg bg-[#0053a8] text-white shadow-sm">
                    {product.tag}
                  </span>
                )}
              </div>
            </div>

            {/* Info Column */}
            <div className="lg:col-span-6 flex flex-col justify-between space-y-6">
              <div>
                <span className="inline-block px-3 py-1 rounded-full bg-[#f5ede8] text-[#0053a8] text-xs font-semibold uppercase tracking-wider mb-2">
                  {product.cat === 'combo' ? 'কম্বো গিফট বক্স' : 'একক উপহার উপাদান'}
                </span>

                <h1 className="text-3xl sm:text-4xl font-extrabold text-[#4a3b3b] tracking-tight">
                  {product.name}
                </h1>

                {/* Price Display */}
                <div className="flex items-baseline gap-3 my-4">
                  <span className="text-3xl font-extrabold text-[#0053a8]">
                    {formatPrice(product.price)}
                  </span>
                  {product.oldPrice && (
                    <span className="text-base line-through text-[#8a7a7a]">
                      {formatPrice(product.oldPrice)}
                    </span>
                  )}
                </div>

                <div className="h-px bg-[#e8dad5] my-4" />

                <p className="text-sm sm:text-base text-[#8a7a7a] leading-relaxed mb-6">
                  {product.details || product.desc}
                </p>

                {/* Quality Guarantees */}
                <div className="space-y-3 bg-[#fbf7f4] p-4 rounded-2xl border border-[#e8dad5] text-xs text-[#4a3b3b]">
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-[#0053a8] shrink-0" />
                    <span>ক্যাশ অন ডেলিভারিতে সম্পূর্ণ সারা বাংলাদেশে ডেলিভারি</span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-[#0053a8] shrink-0" />
                    <span>১০০% প্রিমিয়াম ফিনিশিং, নিখুঁত হ্যান্ডমেড প্যাকেজিং</span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-[#0053a8] shrink-0" />
                    <span>হাতে লেখা ব্যক্তিগত শুভেচ্ছা কার্ড যোগ করার সুবিধা</span>
                  </div>
                </div>
              </div>

              {/* Client Interactive Action Buttons */}
              <ProductDetailActions product={product} />
            </div>
          </div>
        </div>

        {/* Related Products */}
        {related.length > 0 && (
          <div className="pt-6">
            <div className="flex items-center justify-between mb-8">
              <div>
                <span className="text-xs font-bold text-[#0053a8] uppercase tracking-wider">
                  You Might Also Like
                </span>
                <h2 className=" text-2xl font-bold text-[#4a3b3b] mt-1 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-[#0053a8]" />
                  <span>আরও পছন্দসই উপহার</span>
                </h2>
              </div>
              <Link
                href="/shop"
                className="text-xs sm:text-sm font-semibold text-[#0053a8] hover:underline"
              >
                সব দেখুন →
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {related.map((item) => (
                <ProductCard key={item.id} product={item} />
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
