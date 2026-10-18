'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { BoxType } from '@/types';
import { formatPrice } from '@/lib/utils';
import { Package, Sparkles, ShoppingBag } from 'lucide-react';
import { useCart } from '@/context/CartContext';

interface OurBoxesProps {
  boxTypes: BoxType[];
}

export default function OurBoxes({ boxTypes }: OurBoxesProps) {
  const router = useRouter();
  const { selectBox, openOrderModal } = useCart();

  const handleOrderBox = (box: BoxType) => {
    openOrderModal({
      name: `শুধু বক্স: ${box.name}`,
      basePrice: box.price,
      isCustom: false,
    });
  };

  const handleSelectForCustom = (box: BoxType) => {
    selectBox(box);
    router.push('/custom');
  };

  return (
    <section className="py-14">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#f5ede8] text-[#0053a8] text-xs font-semibold mb-2">
            <Package className="w-3.5 h-3.5" />
            <span>প্রিমিয়াম প্যাকেজিং সলিউশন</span>
          </div>
          <h2 className=" text-2xl sm:text-3xl font-bold text-[#4a3b3b]">
            আমাদের প্রিমিয়াম গিফট বক্স
          </h2>
          <p className="text-sm text-[#8a7a7a] mt-2.5 leading-relaxed">
            প্রিমিয়াম কোয়ালিটির ডিজাইন করা মজবুত ও দৃষ্টিনন্দন বক্স। আপনি চাইলে শুধু বক্স অর্ডার করতে পারেন, অথবা আমাদের &quot;নিজে বানান&quot; বিল্ডার দিয়ে এই বক্সে পছন্দের আইটেম সাজিয়ে সম্পূর্ণ কাস্টমাইজড কম্বো উপহার পাঠাতে পারেন।
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {boxTypes.map((box) => (
            <div
              key={box.id}
              className="bg-white rounded-2xl border border-[#e8dad5] overflow-hidden shadow-xs hover:shadow-xl hover:shadow-[#0053a8]/10 transition-all duration-300 hover:-translate-y-1 flex flex-col justify-between"
            >
              <div>
                <div className="relative aspect-square w-full bg-[#f5ede8]/50 overflow-hidden">
                  <Image
                    src={box.img}
                    alt={box.name}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                    className="object-cover hover:scale-105 transition-transform duration-500"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute top-3 right-3 px-2 py-1 rounded-md bg-white/90 backdrop-blur-xs text-[11px] font-bold text-[#0053a8] shadow-xs">
                    {formatPrice(box.price)}
                  </div>
                </div>

                <div className="p-4">
                  <h3 className=" text-base font-bold text-[#4a3b3b] mb-1">
                    {box.name}
                  </h3>
                  <p className="text-xs text-[#8a7a7a] line-clamp-2 leading-relaxed mb-4">
                    {box.desc}
                  </p>
                </div>
              </div>

              <div className="p-4 pt-0 space-y-2">
                <button
                  onClick={() => handleOrderBox(box)}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-[#0053a8] text-white text-xs font-semibold hover:bg-[#e34d01] transition-colors shadow-2xs cursor-pointer"
                >
                  <ShoppingBag className="w-3.5 h-3.5" />
                  <span>শুধু বক্সটি অর্ডার করুন</span>
                </button>
                <button
                  onClick={() => handleSelectForCustom(box)}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border border-[#0053a8] text-[#0053a8] text-xs font-semibold hover:bg-[#f5ede8] transition-colors cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>এই বক্সে উপহার সাজান</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
