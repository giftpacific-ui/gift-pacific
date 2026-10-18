'use client';

import { useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Product } from '@/types';
import { formatPrice } from '@/lib/utils';
import { ChevronLeft, ChevronRight, Plus, Eye } from 'lucide-react';
import { useCart } from '@/context/CartContext';

interface ItemSliderProps {
  products: Product[];
}

export default function ItemSlider({ products }: ItemSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const individualItems = products.filter((p) => p.cat === 'individual');
  const { addToCustomCart } = useCart();

  const scroll = (direction: 'left' | 'right') => {
    if (trackRef.current) {
      const offset = direction === 'left' ? -280 : 280;
      trackRef.current.scrollBy({ left: offset, behavior: 'smooth' });
    }
  };

  return (
    <section className="py-14 bg-[#f5ede8]/50 border-y border-[#e8dad5]/60">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[#0053a8]">
              কাস্টমাইজেবল ইলিমেন্টস
            </span>
            <h2 className=" text-2xl sm:text-3xl font-bold text-[#4a3b3b] mt-1">
              আমাদের কম্বো উপকরণ
            </h2>
            <p className="text-xs sm:text-sm text-[#8a7a7a] mt-1">
              আপনি চাইলে যেকোনো উপাদান আলাদা কিনতে পারেন অথবা নিজে কম্বো বক্সে যুক্ত করতে পারেন
            </p>
          </div>

          {/* Slider controls */}
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <button
              onClick={() => scroll('left')}
              aria-label="Previous items"
              className="w-10 h-10 rounded-full bg-white border border-[#e8dad5] flex items-center justify-center text-[#4a3b3b] hover:bg-[#0053a8] hover:text-white hover:border-[#0053a8] shadow-xs transition-all active:scale-95 cursor-pointer"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => scroll('right')}
              aria-label="Next items"
              className="w-10 h-10 rounded-full bg-white border border-[#e8dad5] flex items-center justify-center text-[#4a3b3b] hover:bg-[#0053a8] hover:text-white hover:border-[#0053a8] shadow-xs transition-all active:scale-95 cursor-pointer"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable track */}
        <div
          ref={trackRef}
          className="flex gap-4 overflow-x-auto no-scrollbar scroll-smooth pb-3 pt-1 -mx-4 px-4 sm:mx-0 sm:px-0"
        >
          {individualItems.map((item) => (
            <div
              key={item.id}
              className="shrink-0 w-52 bg-white rounded-xl border border-[#e8dad5] overflow-hidden shadow-xs hover:shadow-md hover:border-[#0053a8]/50 transition-all group flex flex-col justify-between"
            >
              <Link
                href={`/product/${item.id}`}
                className="relative aspect-square w-full bg-[#fbf7f4] cursor-pointer overflow-hidden p-3 block"
              >
                <div className="relative w-full h-full rounded-lg overflow-hidden">
                  <Image
                    src={item.img}
                    alt={item.name}
                    fill
                    sizes="200px"
                    className="object-cover group-hover:scale-105 transition-transform duration-500"
                    referrerPolicy="no-referrer"
                  />
                </div>
              </Link>

              <div className="p-3.5 flex-1 flex flex-col justify-between">
                <div>
                  <Link href={`/product/${item.id}`}>
                    <h4 className="text-xs sm:text-sm font-semibold text-[#4a3b3b] hover:text-[#0053a8] cursor-pointer truncate mb-1">
                      {item.name}
                    </h4>
                  </Link>
                  <div className="text-xs font-bold text-[#0053a8] mb-3">
                    {formatPrice(item.price)}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-2 border-t border-[#e8dad5]/50">
                  <Link
                    href={`/product/${item.id}`}
                    className="flex-1 py-1.5 px-2 rounded-md bg-[#fbf7f4] border border-[#e8dad5] text-[11px] font-medium text-[#4a3b3b] hover:bg-[#f5ede8] hover:text-[#0053a8] flex items-center justify-center gap-1 transition-colors"
                  >
                    <Eye className="w-3 h-3" />
                    <span>দেখুন</span>
                  </Link>
                  <button
                    onClick={() => addToCustomCart(item)}
                    title="কম্বোতে যোগ করুন"
                    className="p-1.5 rounded-md bg-[#0053a8] text-white hover:bg-[#e34d01] transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
