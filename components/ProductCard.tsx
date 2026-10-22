"use client";

import Image from "next/image";
import Link from "next/link";
import { Product } from "@/types";
import { formatPrice } from "@/lib/utils";
import { ShoppingBag, XCircle } from "lucide-react";
import { useCart } from "@/context/CartContext";

interface ProductCardProps {
  product: Product;
  onOrderNow?: (product: Product) => void;
}

export default function ProductCard({ product, onOrderNow }: ProductCardProps) {
  const { openOrderModal } = useCart();

  const handleOrder = () => {
    if (!product.inStock) return; // স্টক আউট থাকলে ফাংশন চলবে না

    if (onOrderNow) {
      onOrderNow(product);
    } else {
      openOrderModal({
        name: product.name,
        basePrice: product.price,
        isCustom: false,
      });
    }
  };

  return (
    <div className="group relative bg-white rounded-2xl border border-[#e8dad5] overflow-hidden shadow-xs hover:shadow-xl hover:shadow-[#3a3f2b]/10 transition-all duration-300 hover:-translate-y-1 flex flex-col">
      {/* Tag Badge */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-1.5">
        {!product.inStock ? (
          <span className="px-2.5 py-1 text-[11px] font-bold rounded-md bg-red-600 text-white shadow-xs">
            স্টক আউট
          </span>
        ) : product.tag ? (
          <span className="px-2.5 py-1 text-[11px] font-bold rounded-md bg-[#3a3f2b] text-white shadow-xs">
            {product.tag}
          </span>
        ) : null}
      </div>

      {/* Product Image Link */}
      <Link
        href={`/product/${product.slug}`}
        className="relative aspect-square w-full bg-[#f5ede8]/50 overflow-hidden cursor-pointer block"
      >
        <Image
          src={product.img}
          alt={product.name}
          fill
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
          className={`object-cover transition-transform duration-500 ${
            !product.inStock ? "grayscale opacity-80" : "group-hover:scale-105"
          }`}
          referrerPolicy="no-referrer"
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
      </Link>

      {/* Content */}
      <div className="p-4 flex-1 flex flex-col justify-between">
        <div>
          <Link href={`/product/${product.slug}`}>
            <h3 className="text-base font-bold text-[#3a3f2b] hover:text-[#3a3f2b] cursor-pointer transition-colors line-clamp-1 mb-1">
              {product.name}
            </h3>
          </Link>
          <p className="text-xs text-black line-clamp-2 min-h-[32px] mb-3 leading-relaxed">
            {product.desc}
          </p>
        </div>

        {/* Price & Action */}
        <div className="pt-2 border-t border-[#e8dad5]/60 flex items-center justify-between gap-2">
          <div className="flex gap-2 items-center">
            <span className="text-base font-bold text-[#3a3f2b]">
              {formatPrice(product.price)}
            </span>{" "}
            {product.oldPrice && (
              <span className="text-[14px] line-through text-red-600">
                {formatPrice(product.oldPrice)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={handleOrder}
              disabled={!product.inStock}
              className={`inline-flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors shadow-2xs ${
                product.inStock
                  ? "bg-[#3a3f2b] text-white hover:bg-[#000] cursor-pointer"
                  : "bg-gray-300 text-gray-500 cursor-not-allowed"
              }`}
            >
              {product.inStock ? (
                <>
                  <ShoppingBag className="w-3.5 h-3.5" />
                  <span>অর্ডার</span>
                </>
              ) : (
                <>
                  <XCircle className="w-3.5 h-3.5" />
                  <span>স্টক আউট</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
