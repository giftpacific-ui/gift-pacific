'use client';

import { Product } from '@/types';
import { useCart } from '@/context/CartContext';
import { ShoppingBag, Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';

interface ProductDetailActionsProps {
  product: Product;
}

export default function ProductDetailActions({ product }: ProductDetailActionsProps) {
  const { openOrderModal, addToCustomCart } = useCart();

  const handleBuyNow = () => {
    openOrderModal({
      name: product.name,
      basePrice: product.price,
      isCustom: false,
    });
  };

  const handleAdd = () => {
    addToCustomCart(product);
  };

  return (
    <div className="space-y-3 pt-4 border-t border-[#e8dad5]">
      <button
        onClick={handleBuyNow}
        className="w-full py-4 px-6 rounded-2xl bg-[#0053a8] text-white font-bold text-sm sm:text-base hover:bg-[#e34d01] transition-all flex items-center justify-center gap-2 shadow-lg shadow-[#0053a8]/20 hover:-translate-y-0.5 cursor-pointer"
      >
        <ShoppingBag className="w-5 h-5" />
        <span>Buy Now (Cash on Delivery)</span>
      </button>

      {product.cat === 'individual' ? (
        <button
          onClick={handleAdd}
          className="w-full py-3.5 px-6 rounded-2xl border-2 border-[#0053a8] text-[#0053a8] font-semibold text-sm hover:bg-[#f5ede8] transition-colors flex items-center justify-center gap-2 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>কাস্টম কম্বো বক্সে যোগ করুন</span>
        </button>
      ) : (
        <Link
          href="/custom"
          className="w-full py-3.5 px-6 rounded-2xl border border-[#e8dad5] text-[#8a7a7a] hover:text-[#0053a8] hover:bg-[#f5ede8]/50 font-semibold text-xs sm:text-sm transition-colors flex items-center justify-center gap-2 text-center"
        >
          <Sparkles className="w-4 h-4 text-[#0053a8]" />
          <span>অথবা এই উপহার দিয়ে নিজের মতো কম্বো বানান →</span>
        </Link>
      )}
    </div>
  );
}
