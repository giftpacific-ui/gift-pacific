"use client";

import { useState } from "react";
import { Product, ProductCategory } from "@/types";
import ProductCard from "./ProductCard";
import { ShoppingCart } from "lucide-react";
import TrackPageEvent from "./TrackPageEvent";

interface ShopSectionProps {
  products: Product[];
}

export default function ShopSection({ products }: ShopSectionProps) {
  const [selectedFilter, setSelectedFilter] = useState<"all" | ProductCategory>(
    "all",
  );

  const filteredProducts =
    selectedFilter === "all"
      ? products
      : products.filter((p) => p.cat === selectedFilter);

  return (
    <section className="py-12 sm:py-16">
      <TrackPageEvent
        eventName="ViewContent"
        data={{
          content_name: "Shop / All Products",
          content_category: "Product Catalog",
          content_type: "product_group",
          content_ids: products.map((p) => p.id),
        }}
      />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#f5ede8] text-[#3a3f2b] text-xs font-semibold mb-2">
            <ShoppingCart className="w-3.5 h-3.5" />
            <span>আমাদের সম্পূর্ণ শপ</span>
          </div>
          <h2 className=" text-2xl sm:text-3xl font-bold text-[#3a3f2b]">
            আমাদের কালেকশন
          </h2>
          <p className="text-sm text-black mt-2">
            আপনার পছন্দের কম্বো গিফট বক্স বা একক উপাদান বেছে নিয়ে যেকোনো
            মুহূর্তে ভালোবাসা জানান
          </p>

          {/* Filter pills */}
          <div className="flex items-center justify-center gap-2 mt-6 flex-wrap">
            <button
              onClick={() => setSelectedFilter("all")}
              className={`px-4 py-1.5 rounded-full text-xs sm:text-sm font-semibold transition-all cursor-pointer ${
                selectedFilter === "all"
                  ? "bg-[#3a3f2b] text-white shadow-xs"
                  : "bg-white border border-[#e8dad5] text-black hover:border-[#3a3f2b] hover:text-[#3a3f2b]"
              }`}
            >
              সব ({products.length})
            </button>
            <button
              onClick={() => setSelectedFilter("combo")}
              className={`px-4 py-1.5 rounded-full text-xs sm:text-sm font-semibold transition-all cursor-pointer ${
                selectedFilter === "combo"
                  ? "bg-[#3a3f2b] text-white shadow-xs"
                  : "bg-white border border-[#e8dad5] text-black hover:border-[#3a3f2b] hover:text-[#3a3f2b]"
              }`}
            >
              কম্বো প্যাক ({products.filter((p) => p.cat === "combo").length})
            </button>
            <button
              onClick={() => setSelectedFilter("individual")}
              className={`px-4 py-1.5 rounded-full text-xs sm:text-sm font-semibold transition-all cursor-pointer ${
                selectedFilter === "individual"
                  ? "bg-[#3a3f2b] text-white shadow-xs"
                  : "bg-white border border-[#e8dad5] text-black hover:border-[#3a3f2b] hover:text-[#3a3f2b]"
              }`}
            >
              ইন্ডিভিজুয়াল উপকরণ (
              {products.filter((p) => p.cat === "individual").length})
            </button>
          </div>
        </div>

        {/* Product Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {filteredProducts.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </div>
    </section>
  );
}
