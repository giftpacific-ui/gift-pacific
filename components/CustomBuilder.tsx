'use client';

import Image from 'next/image';
import { Product, BoxType } from '@/types';
import { formatPrice, toBengaliNum } from '@/lib/utils';
import { Sparkles, Trash2, Plus, Minus, Package, ShoppingCart } from 'lucide-react';
import { useCart } from '@/context/CartContext';

interface CustomBuilderProps {
  products: Product[];
  boxTypes: BoxType[];
}

export default function CustomBuilder({ products, boxTypes }: CustomBuilderProps) {
  const {
    selectedBox,
    customCart,
    selectBox,
    addToCustomCart,
    updateCustomCartQty,
    removeFromCustomCart,
    openOrderModal,
    showToast,
  } = useCart();

  const individualItems = products.filter((p) => p.cat === 'individual');

  const boxTotal = selectedBox ? selectedBox.price : 0;
  const itemsTotal = customCart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const subTotal = boxTotal + itemsTotal;
  const totalItemsCount = customCart.reduce((sum, item) => sum + item.qty, 0);

  const handleOrderCustom = () => {
    if (!selectedBox && customCart.length === 0) {
      showToast('⚠️ অনুগ্রহ করে অন্তত একটি বক্স বা উপকরণ যোগ করুন!');
      return;
    }

    let basePrice = 0;
    const parts: string[] = [];

    if (selectedBox) {
      basePrice += selectedBox.price;
      parts.push(`বক্স: ${selectedBox.name}`);
    }

    if (customCart.length > 0) {
      basePrice += itemsTotal;
      const itemsList = customCart.map((it) => `${it.name} (x${it.qty})`).join(', ');
      parts.push(`উপকরণ: ${itemsList}`);
    }

    openOrderModal({
      name: parts.join(' | '),
      basePrice,
      isCustom: true,
    });
  };

  return (
    <section className="py-12 sm:py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#f5ede8] text-[#3a3f2b] text-xs font-semibold mb-2">
            <Sparkles className="w-3.5 h-3.5" />
            <span>কাস্টম কম্বো বিল্ডার</span>
          </div>
          <h2 className=" text-2xl sm:text-3xl font-bold text-[#3a3f2b]">
            নিজে বানান মনের মতো কম্বো
          </h2>
          <p className="text-sm text-black mt-2">
            প্রথমে একটি আকর্ষণীয় গিফট বক্স বাছাই করুন, এরপর আপনার পছন্দের উপকরণগুলো যোগ করে তৈরি করুন সম্পূর্ণ অনন্য উপহার।
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Column: Selection Controls */}
          <div className="lg:col-span-8 space-y-8">
            {/* 1. Box Selector */}
            <div className="bg-white p-6 rounded-2xl border border-[#e8dad5] shadow-xs">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-[#f5ede8] text-[#3a3f2b] flex items-center justify-center font-bold text-sm">
                    ১
                  </div>
                  <h3 className=" text-lg font-bold text-[#3a3f2b]">
                    বক্স সিলেক্ট করুন
                  </h3>
                </div>
                {selectedBox && (
                  <button
                    onClick={() => selectBox(null)}
                    className="text-xs text-black hover:text-[#3a3f2b] underline cursor-pointer"
                  >
                    বক্স বাতিল করুন
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
                {boxTypes.map((box) => {
                  const isSelected = selectedBox?.id === box.id;
                  return (
                    <div
                      key={box.id}
                      onClick={() => selectBox(box)}
                      className={`relative p-3 rounded-xl border text-center cursor-pointer transition-all ${
                        isSelected
                          ? 'border-[#3a3f2b] bg-[#f5ede8]/40 ring-2 ring-[#3a3f2b]/30 shadow-xs'
                          : 'border-[#e8dad5] bg-[#fbf7f4]/40 hover:border-[#3a3f2b]/60'
                      }`}
                    >
                      <div className="relative aspect-square w-full rounded-lg overflow-hidden mb-2 bg-white">
                        <Image
                          src={box.img}
                          alt={box.name}
                          fill
                          sizes="150px"
                          className="object-cover"
                          referrerPolicy="no-referrer"
                        />
                      </div>
                      <div className="text-xs font-semibold text-[#3a3f2b] truncate">
                        {box.name}
                      </div>
                      <div className="text-xs font-bold text-[#3a3f2b] mt-0.5">
                        {formatPrice(box.price)}
                      </div>
                      {isSelected && (
                        <div className="mt-2 py-0.5 text-[10px] font-bold rounded-md bg-[#3a3f2b] text-white">
                          সিলেক্টেড
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 2. Items Selector */}
            <div className="bg-white p-6 rounded-2xl border border-[#e8dad5] shadow-xs">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-[#f5ede8] text-[#3a3f2b] flex items-center justify-center font-bold text-sm">
                  ২
                </div>
                <div>
                  <h3 className=" text-lg font-bold text-[#3a3f2b]">
                    উপকরণ বেছে নিন
                  </h3>
                  <p className="text-xs text-black">
                    বক্সে যোগ করতে &quot;+ যোগ করুন&quot; বাটনে ক্লিক করুন
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {individualItems.map((item) => {
                  const inCart = customCart.find((c) => c.id === item.id);
                  return (
                    <div
                      key={item.id}
                      className="bg-[#fbf7f4]/50 border border-[#e8dad5] rounded-xl p-3 flex flex-col justify-between hover:border-[#3a3f2b]/40 transition-colors"
                    >
                      <div className="relative aspect-square w-full rounded-lg overflow-hidden mb-2 bg-white">
                        <Image
                          src={item.img}
                          alt={item.name}
                          fill
                          sizes="180px"
                          className="object-cover"
                          referrerPolicy="no-referrer"
                        />
                      </div>
                      <div>
                        <h4 className="text-xs sm:text-sm font-semibold text-[#3a3f2b] truncate">
                          {item.name}
                        </h4>
                        <div className="text-xs font-bold text-[#3a3f2b] mt-0.5 mb-2.5">
                          {formatPrice(item.price)}
                        </div>
                      </div>

                      {inCart ? (
                        <div className="flex items-center justify-between bg-white border border-[#3a3f2b]/40 rounded-lg p-1">
                          <button
                            onClick={() => updateCustomCartQty(item.id, -1)}
                            className="w-6 h-6 rounded-md bg-[#f5ede8] text-[#3a3f2b] flex items-center justify-center hover:bg-[#3a3f2b] hover:text-white transition-colors cursor-pointer"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="text-xs font-bold text-[#3a3f2b]">
                            {toBengaliNum(inCart.qty)}
                          </span>
                          <button
                            onClick={() => updateCustomCartQty(item.id, 1)}
                            className="w-6 h-6 rounded-md bg-[#3a3f2b] text-white flex items-center justify-center hover:bg-[#000] transition-colors cursor-pointer"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => addToCustomCart(item)}
                          className="w-full py-1.5 px-2 rounded-lg bg-white border border-[#e8dad5] text-xs font-semibold text-[#3a3f2b] hover:bg-[#3a3f2b] hover:text-white transition-colors flex items-center justify-center gap-1 shadow-2xs cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>যোগ করুন</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Column: Sticky Summary Box */}
          <div className="lg:col-span-4 sticky top-24">
            <div className="bg-white rounded-2xl border border-[#e8dad5] p-6 shadow-xs">
              <div className="flex items-center gap-2 pb-4 border-b border-[#e8dad5]">
                <Package className="w-5 h-5 text-[#3a3f2b]" />
                <h3 className=" text-lg font-bold text-[#3a3f2b]">
                  আপনার কাস্টম বক্স
                </h3>
              </div>

              {/* Selected Box Display */}
              <div className="py-4 border-b border-dashed border-[#e8dad5]">
                <div className="text-xs font-medium text-black mb-2">
                  প্যাকেজিং বক্স:
                </div>
                {selectedBox ? (
                  <div className="flex items-center justify-between bg-[#f5ede8]/60 p-2.5 rounded-xl border border-[#e8dad5]">
                    <div className="flex items-center gap-2.5">
                      <div className="relative w-10 h-10 rounded-lg overflow-hidden shrink-0">
                        <Image
                          src={selectedBox.img}
                          alt={selectedBox.name}
                          fill
                          className="object-cover"
                          referrerPolicy="no-referrer"
                        />
                      </div>
                      <div>
                        <div className="text-xs font-bold text-[#3a3f2b]">
                          {selectedBox.name}
                        </div>
                        <div className="text-[11px] font-semibold text-[#3a3f2b]">
                          {formatPrice(selectedBox.price)}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => selectBox(null)}
                      className="text-xs text-black hover:text-red-500 p-1 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200/60 p-2.5 rounded-xl">
                    ⚠️ এখনো বক্স সিলেক্ট করেননি। বাম পাশ থেকে একটি বক্স বেছে নিন।
                  </div>
                )}
              </div>

              {/* Selected Items List */}
              <div className="py-4 border-b border-[#e8dad5]">
                <div className="flex items-center justify-between text-xs font-medium text-black mb-2">
                  <span>বক্সের ভেতরের উপকরণ ({toBengaliNum(totalItemsCount)}টি):</span>
                </div>

                {customCart.length === 0 ? (
                  <p className="text-xs text-black text-center py-4 bg-[#fbf7f4] rounded-xl border border-dashed border-[#e8dad5]">
                    এখনো কোনো উপাদান যোগ করেননি।
                  </p>
                ) : (
                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {customCart.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between text-xs bg-[#fbf7f4] p-2 rounded-lg"
                      >
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => removeFromCustomCart(item.id)}
                            className="text-black hover:text-red-500 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                          <span className="font-medium text-[#3a3f2b] line-clamp-1 max-w-[130px]">
                            {item.name}
                          </span>
                          <span className="text-[11px] text-black">
                            x{toBengaliNum(item.qty)}
                          </span>
                        </div>
                        <span className="font-bold text-[#3a3f2b]">
                          {formatPrice(item.price * item.qty)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Total Calculation */}
              <div className="pt-4 space-y-2">
                <div className="flex items-center justify-between text-xs text-black">
                  <span>বক্সের মূল্য:</span>
                  <span>{formatPrice(boxTotal)}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-black">
                  <span>উপকরণের মূল্য:</span>
                  <span>{formatPrice(itemsTotal)}</span>
                </div>
                <div className="flex items-center justify-between text-base font-bold text-[#3a3f2b] pt-2 border-t border-[#e8dad5]">
                  <span>সাব-টোটাল:</span>
                  <span className="text-lg text-[#3a3f2b]">{formatPrice(subTotal)}</span>
                </div>
                <div className="text-[11px] text-black italic">
                  * ডেলিভারি চার্জ অর্ডার কনফার্ম করার সময় যুক্ত হবে।
                </div>
              </div>

              {/* Order Button */}
              <button
                onClick={handleOrderCustom}
                disabled={!selectedBox && customCart.length === 0}
                className="mt-5 w-full py-3.5 px-4 rounded-xl bg-[#3a3f2b] text-white font-semibold flex items-center justify-center gap-2 hover:bg-[#000] transition-all shadow-md shadow-[#3a3f2b]/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <ShoppingCart className="w-4 h-4" />
                <span>অর্ডার করুন (COD)</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
