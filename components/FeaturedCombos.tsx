"use client";

import Link from "next/link";
import { Product } from "@/types";
import ProductCard from "./ProductCard";
import { Gift } from "lucide-react";

interface FeaturedCombosProps {
  products: Product[];
}

export default function FeaturedCombos({ products }: FeaturedCombosProps) {
  const combos = products.filter((p) => p.cat === "combo");

  return (
    <section className="py-12 bg-transparent">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#f5ede8] text-[#3a3f2b] text-xs font-semibold mb-2">
            <Gift className="w-3.5 h-3.5" />
            <span>রেডিমেড কম্বো কালেকশন</span>
          </div>
          <h2 className=" text-2xl sm:text-3xl font-bold text-[#3a3f2b]">
            আমাদের কিউরেটেড কম্বো প্যাক
          </h2>
          <p className="text-sm text-black mt-2">
            ভালোবাসার প্রতিটি অনুভূতি প্রকাশের জন্য বিশেষভাবে তৈরি সম্পূর্ণ
            রেডিমেড কম্বো গিফট বক্স
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {combos.map((combo) => (
            <ProductCard key={combo.id} product={combo} />
          ))}
        </div>
      </div>
    </section>
  );
}
