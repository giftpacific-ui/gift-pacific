/* eslint-disable react-hooks/purity */
/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useState, useEffect } from "react";
import { formatPrice, getDeviceInfo } from "@/lib/utils";
import {
  DELIVERY_CHARGE_INSIDE,
  DELIVERY_CHARGE_OUTSIDE,
} from "@/data/products";
import { trackPixelEvent } from "@/lib/analytics";
import {
  X,
  CheckCircle,
  AlertCircle,
  ShoppingBag,
  Loader2,
  Gift,
  PlusCircle,
} from "lucide-react";

interface OrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderItem: {
    name: string;
    basePrice: number;
    isCustom?: boolean;
    cat?: string; // ক্যাটাগরি ট্র্যাক করার জন্য (miniCombo, individual, fullCombo etc.)
  } | null;
  onOrderSuccess?: () => void;
}

export default function OrderModal({
  isOpen,
  onClose,
  orderItem,
  onOrderSuccess,
}: OrderModalProps) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [deliveryArea, setDeliveryArea] = useState<"inside" | "outside">(
    "inside",
  );
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  // Google Preferred Source & 50% Delivery Discount State
  const [isDiscountApplied, setIsDiscountApplied] = useState(false);

  // Mini Combo Box Option State (True = With Box @ 499, False = Without Box @ 299)
  const [includeBox, setIncludeBox] = useState(true);

  // Individual Product Upsell Box State (True = Add Elegant Gift Box for +200 BDT, False = Just Product)
  const [addIndividualBox, setAddIndividualBox] = useState(false);

  // Category Checkers
  const isMiniCombo = orderItem?.cat === "miniCombo";
  const isIndividual = orderItem?.cat === "individual";

  // Modal open hole state reset
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      setIncludeBox(true); // মিনি কম্বোর জন্য ডিফল্ট বক্সসহ
      setAddIndividualBox(false); // ইন্ডিভিজুয়ালের জন্য ডিফল্ট বক্স ছাড়া
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  if (!isOpen || !orderItem) return null;

  // ডাইনামিক বেস প্রাইস ক্যালকুলেশন
  let currentBasePrice = orderItem.basePrice;

  if (isMiniCombo) {
    currentBasePrice = includeBox ? 499 : 299;
  } else if (isIndividual) {
    // ইন্ডিভিজুয়াল আইটেমের সাথে বক্স চাইলে অতিরিক্ত ২৫০ টাকা যোগ হবে
    currentBasePrice = addIndividualBox
      ? orderItem.basePrice + 200
      : orderItem.basePrice;
  }

  const baseDeliveryCharge =
    deliveryArea === "inside"
      ? DELIVERY_CHARGE_INSIDE
      : DELIVERY_CHARGE_OUTSIDE;

  // Google Preferred Source click korle 50% off
  const deliveryCharge = isDiscountApplied
    ? baseDeliveryCharge * 0.5
    : baseDeliveryCharge;

  const grandTotal = currentBasePrice + deliveryCharge;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setStatus("idle");
    setErrorMessage("");

    const eventId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // পণ্যের নামের সাথে ভেরিয়েন্ট বা বক্সের তথ্য যুক্ত করে দেওয়া
    let finalProductName = orderItem.name;
    if (isMiniCombo) {
      finalProductName = `${orderItem.name} (${includeBox ? "Elegant Gift Box সহ" : "শুধু প্রোডাক্ট, বক্স ছাড়া"})`;
    } else if (isIndividual && addIndividualBox) {
      finalProductName = `${orderItem.name} + Elegant Gift Box (৳২৫০)`;
    }

    const orderPayload = {
      type: "order",
      name,
      phone,
      address,
      product: finalProductName,
      basePrice: currentBasePrice,
      deliveryCharge,
      deliveryArea:
        deliveryArea === "inside" ? "Inside Dhaka" : "Outside Dhaka",
      price: grandTotal,
      device: getDeviceInfo(),
      location: "Fetching...",
      eventId,
    };

    try {
      trackPixelEvent("Purchase", {
        value: grandTotal,
        currency: "BDT",
        content_name: finalProductName,
        eventID: eventId,
      });

      const res = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderPayload),
      });

      if (!res.ok) {
        throw new Error("Server error");
      }

      setStatus("success");
      if (onOrderSuccess) onOrderSuccess();
    } catch (err) {
      console.error("Order submission error:", err);
      setStatus("error");
      setErrorMessage(
        "অর্ডার সম্পন্ন করতে সমস্যা হয়েছে, অনুগ্রহ করে আবার চেষ্টা করুন।",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetAndClose = () => {
    setName("");
    setPhone("");
    setAddress("");
    setStatus("idle");
    setIsDiscountApplied(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-[#3a3f2b]/60 backdrop-blur-xs overflow-y-auto">
      <div
        className="relative w-full max-w-lg bg-white rounded-3xl border border-[#e8dad5] shadow-2xl p-6 sm:p-8 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleResetAndClose}
          aria-label="Close modal"
          className="absolute top-5 right-5 p-2 rounded-full text-black hover:bg-[#f5ede8] hover:text-[#3a3f2b] transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        {status === "success" ? (
          <div className="py-6 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
              <CheckCircle className="w-8 h-8" />
            </div>
            <h3 className="text-2xl font-bold text-[#3a3f2b]">
              অর্ডার সফলভাবে জমা হয়েছে!
            </h3>
            <p className="text-sm text-black max-w-sm mx-auto leading-relaxed">
              ধন্যবাদ{" "}
              <span className="font-semibold text-[#3a3f2b]">{name}</span>!
              আমাদের টিম দ্রুত আপনার সাথে যোগাযোগ করবে।
            </p>
            <button
              onClick={handleResetAndClose}
              className="mt-4 px-6 py-2.5 rounded-xl bg-[#3a3f2b] text-white font-semibold text-sm hover:bg-[#000] transition-colors cursor-pointer"
            >
              ঠিক আছে
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-4">
              <span className="text-xs font-bold text-[#3a3f2b] uppercase tracking-wider">
                ক্যাশ অন ডেলিভারি চেকআউট
              </span>
              <h3 className="text-2xl font-bold text-[#3a3f2b] mt-1">
                অর্ডার নিশ্চিত করুন
              </h3>
            </div>

            {/* ১. মিনি কম্বো (miniCombo) হলে বক্স অপশন দেখাবে */}
            {isMiniCombo && (
              <div className="mb-4 p-3 bg-[#fbf7f4] rounded-2xl border border-[#e8dad5]">
                <label className="block text-xs font-bold text-[#3a3f2b] mb-2 flex items-center gap-1.5">
                  <Gift className="w-4 h-4 text-[#3a3f2b]" />
                  <span>প্যাকেজিং অপশন সিলেক্ট করুন:</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setIncludeBox(false)}
                    className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer text-center ${
                      !includeBox
                        ? "bg-[#3a3f2b] text-white border-[#3a3f2b] shadow-xs"
                        : "bg-white text-[#3a3f2b] border-[#e8dad5] hover:bg-[#f5ede8]"
                    }`}
                  >
                    <div>শুধু প্রোডাক্ট</div>
                    <div className="text-[12px] opacity-90 mt-0.5">
                      ৳২৯৯ (বক্স ছাড়া)
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIncludeBox(true)}
                    className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer text-center ${
                      includeBox
                        ? "bg-[#3a3f2b] text-white border-[#3a3f2b] shadow-xs"
                        : "bg-white text-[#3a3f2b] border-[#e8dad5] hover:bg-[#f5ede8]"
                    }`}
                  >
                    <div>বক্সসহ কম্বো</div>
                    <div className="text-[12px] opacity-90 mt-0.5">
                      +{formatPrice(200)} (Elegant Box)
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* ২. ইন্ডিভিজুয়াল (individual) প্রোডাক্ট হলে গিফট বক্স যোগ করার আপসেল অপশন দেখাবে */}
            {isIndividual && (
              <div className="mb-4 p-3 bg-[#fbf7f4] rounded-2xl border border-[#e8dad5]">
                <label className="block text-xs font-bold text-[#3a3f2b] mb-2 flex items-center gap-1.5">
                  <PlusCircle className="w-4 h-4 text-[#3a3f2b]" />
                  <span>উপহার দেওয়ার জন্য প্রিমিয়াম বক্স যোগ করতে চান?</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setAddIndividualBox(true)}
                    className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer text-center ${
                      addIndividualBox
                        ? "bg-[#3a3f2b] text-white border-[#3a3f2b] shadow-xs"
                        : "bg-white text-[#3a3f2b] border-[#e8dad5] hover:bg-[#f5ede8]"
                    }`}
                  >
                    <div>বক্সসহ নিন</div>
                    <div className="text-[11px] opacity-90 mt-0.5">
                      +{formatPrice(200)} (Elegant Box)
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAddIndividualBox(false)}
                    className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer text-center ${
                      !addIndividualBox
                        ? "bg-[#3a3f2b] text-white border-[#3a3f2b] shadow-xs"
                        : "bg-white text-[#3a3f2b] border-[#e8dad5] hover:bg-[#f5ede8]"
                    }`}
                  >
                    <div>শুধু প্রোডাক্ট</div>
                    <div className="text-[11px] opacity-90 mt-0.5">
                      বক্স ছাড়া
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* Product & Price Summary Card */}
            <div className="bg-[#f5ede8]/70 p-4 rounded-2xl border border-[#e8dad5] mb-5 space-y-2">
              <div className="flex justify-between items-start gap-4">
                <span className="text-xs font-semibold text-[#3a3f2b] line-clamp-2">
                  {orderItem.name}{" "}
                  {isMiniCombo &&
                    (includeBox ? " + Elegant Gift Box" : " (বক্স ছাড়া)")}
                  {isIndividual && addIndividualBox && " + Elegant Gift Box"}
                </span>
                <span className="text-xs font-bold text-[#3a3f2b] shrink-0">
                  {formatPrice(currentBasePrice)}
                </span>
              </div>
              <div className="flex justify-between text-xs text-black pt-1.5 border-t border-[#e8dad5]">
                <span>ডেলিভারি চার্জ:</span>
                <span className="flex items-center gap-1.5">
                  {isDiscountApplied && (
                    <span className="line-through text-gray-400">
                      {formatPrice(baseDeliveryCharge)}
                    </span>
                  )}
                  <span
                    className={
                      isDiscountApplied ? "font-bold text-emerald-600" : ""
                    }
                  >
                    {formatPrice(deliveryCharge)}
                  </span>
                </span>
              </div>
              <div className="flex justify-between text-sm font-bold text-[#3a3f2b] pt-1">
                <span>সর্বমোট:</span>
                <span className="text-base text-[#3a3f2b]">
                  {formatPrice(grandTotal)}
                </span>
              </div>
            </div>

            {status === "error" && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Order Form */}
            <form onSubmit={handleSubmit} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-[#3a3f2b] mb-1">
                  আপনার পুরো নাম <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="যেমন: রাহাত মাহমুদ"
                  className="w-full px-3.5 py-2 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#3a3f2b] focus:bg-white focus:border-[#3a3f2b] focus:outline-none transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#3a3f2b] mb-1">
                  মোবাইল নম্বর <span className="text-red-500">*</span>
                </label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="017XXXXXXXX"
                  className="w-full px-3.5 py-2 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#3a3f2b] focus:bg-white focus:border-[#3a3f2b] focus:outline-none transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#3a3f2b] mb-1">
                  সম্পূর্ণ ডেলিভারি ঠিকানা{" "}
                  <span className="text-red-500">*</span>
                </label>
                <textarea
                  required
                  rows={2}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="বাড়ি/রোড নং, থানা, জেলা"
                  className="w-full px-3.5 py-2 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#3a3f2b] focus:bg-white focus:border-[#3a3f2b] focus:outline-none transition-colors resize-none"
                />
              </div>

              {/* Google Preferred Source Button Container */}
              <div
                className="py-1 cursor-pointer"
                onClick={() => setIsDiscountApplied(true)}
              >
                <div google-add-preferred-source-btn="true"></div>
                {isDiscountApplied && (
                  <p className="text-[11px] text-emerald-600 font-medium mt-1">
                    ✓ ডেলিভারি চার্জে ৫০% ডিসকাউন্ট সফলভাবে যুক্ত হয়েছে!
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#3a3f2b] mb-1">
                  ডেলিভারি এরিয়া <span className="text-red-500">*</span>
                </label>
                <select
                  value={deliveryArea}
                  onChange={(e) =>
                    setDeliveryArea(e.target.value as "inside" | "outside")
                  }
                  className="w-full px-3.5 py-2 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#3a3f2b] font-medium focus:bg-white focus:border-[#3a3f2b] focus:outline-none transition-colors cursor-pointer"
                >
                  <option value="inside">
                    ঢাকার ভেতরে ({formatPrice(DELIVERY_CHARGE_INSIDE)})
                  </option>
                  <option value="outside">
                    ঢাকার বাইরে ({formatPrice(DELIVERY_CHARGE_OUTSIDE)})
                  </option>
                </select>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3 px-4 rounded-xl bg-[#3a3f2b] text-white font-semibold text-sm hover:bg-[#000] transition-all flex items-center justify-center gap-2 shadow-md shadow-[#3a3f2b]/20 disabled:opacity-60 cursor-pointer"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>অর্ডার প্রসেস হচ্ছে...</span>
                    </>
                  ) : (
                    <>
                      <ShoppingBag className="w-4 h-4" />
                      <span>কনফার্ম অর্ডার ({formatPrice(grandTotal)})</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
