"use client";

import { useState } from "react";
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
} from "lucide-react";

interface OrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderItem: {
    name: string;
    basePrice: number;
    isCustom?: boolean;
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

  if (!isOpen || !orderItem) return null;

  const deliveryCharge =
    deliveryArea === "inside"
      ? DELIVERY_CHARGE_INSIDE
      : DELIVERY_CHARGE_OUTSIDE;
  const grandTotal = orderItem.basePrice + deliveryCharge;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setStatus("idle");
    setErrorMessage("");

    // Generate unique Event ID for Deduplication
    const eventId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const orderPayload = {
      type: "order",
      name,
      phone,
      address,
      product: orderItem.name,
      basePrice: orderItem.basePrice,
      deliveryCharge,
      deliveryArea:
        deliveryArea === "inside" ? "Inside Dhaka" : "Outside Dhaka",
      price: grandTotal,
      device: getDeviceInfo(),
      location: "Fetching...",
      eventId, // Event ID passed for backend CAPI
    };

    try {
      // 1. Track Client-side Meta Pixel Purchase event with eventID
      trackPixelEvent("Purchase", {
        value: grandTotal,
        currency: "BDT",
        content_name: orderItem.name,
        eventID: eventId,
      });

      // 2. Call Server API (Triggers Google Sheet + Server-side CAPI)
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
        "অর্ডার সম্পন্ন করতে সমস্যা হয়েছে, অনুগ্রহ করে আবার চেষ্টা করুন বা সরাসরি আমাদের ফোনে যোগাযোগ করুন।",
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
          className="absolute top-5 right-5 p-2 rounded-full text-black hover:bg-[#f5ede8] hover:text-[#3a3f2b] transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {status === "success" ? (
          <div className="py-6 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
              <CheckCircle className="w-8 h-8" />
            </div>
            <h3 className=" text-2xl font-bold text-[#3a3f2b]">
              অর্ডার সফলভাবে জমা হয়েছে!
            </h3>
            <p className="text-sm text-black max-w-sm mx-auto leading-relaxed">
              ধন্যবাদ{" "}
              <span className="font-semibold text-[#3a3f2b]">{name}</span>!
              আমাদের সাপোর্ট টিম খুব শীঘ্রই আপনার সাথে ফোনে যোগাযোগ করে অর্ডার
              কনফার্ম করবে।
            </p>
            <div className="p-4 bg-[#fbf7f4] rounded-2xl border border-[#e8dad5] text-left text-xs space-y-1.5 max-w-sm mx-auto">
              <div className="flex justify-between">
                <span className="text-black">প্রোডাক্ট:</span>
                <span className="font-semibold text-[#3a3f2b] line-clamp-1">
                  {orderItem.name}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-black">পেমেন্ট মেথড:</span>
                <span className="font-semibold text-emerald-700">
                  ক্যাশ অন ডেলিভারি (COD)
                </span>
              </div>
              <div className="flex justify-between text-sm font-bold pt-2 border-t border-[#e8dad5]">
                <span>মোট প্রদেয়:</span>
                <span className="text-[#3a3f2b]">
                  {formatPrice(grandTotal)}
                </span>
              </div>
            </div>
            <button
              onClick={handleResetAndClose}
              className="mt-4 px-6 py-2.5 rounded-xl bg-[#3a3f2b] text-white font-semibold text-sm hover:bg-[#000] transition-colors"
            >
              ঠিক আছে
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-6">
              <span className="text-xs font-bold text-[#3a3f2b] uppercase tracking-wider">
                ক্যাশ অন ডেলিভারি চেকআউট
              </span>
              <h3 className=" text-2xl font-bold text-[#3a3f2b] mt-1">
                অর্ডার নিশ্চিত করুন
              </h3>
            </div>

            {/* Product & Price Summary Card */}
            <div className="bg-[#f5ede8]/70 p-4 rounded-2xl border border-[#e8dad5] mb-6 space-y-2">
              <div className="flex justify-between items-start gap-4">
                <span className="text-xs font-semibold text-[#3a3f2b] line-clamp-2">
                  {orderItem.name}
                </span>
                <span className="text-xs font-bold text-[#3a3f2b] shrink-0">
                  {formatPrice(orderItem.basePrice)}
                </span>
              </div>
              <div className="flex justify-between text-xs text-black pt-1.5 border-t border-[#e8dad5]">
                <span>ডেলিভারি চার্জ:</span>
                <span>{formatPrice(deliveryCharge)}</span>
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
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#3a3f2b] mb-1.5">
                  আপনার পুরো নাম <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="যেমন: রাহাত মাহমুদ"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#3a3f2b] focus:bg-white focus:border-[#3a3f2b] focus:outline-none transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#3a3f2b] mb-1.5">
                  মোবাইল নম্বর <span className="text-red-500">*</span>
                </label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="017XXXXXXXX"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#3a3f2b] focus:bg-white focus:border-[#3a3f2b] focus:outline-none transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#3a3f2b] mb-1.5">
                  সম্পূর্ণ ডেলিভারি ঠিকানা{" "}
                  <span className="text-red-500">*</span>
                </label>
                <textarea
                  required
                  rows={2}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="বাড়ি/রোড নং, থানা, জেলা"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#3a3f2b] focus:bg-white focus:border-[#3a3f2b] focus:outline-none transition-colors resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#3a3f2b] mb-1.5">
                  ডেলিভারি এরিয়া <span className="text-red-500">*</span>
                </label>
                <select
                  value={deliveryArea}
                  onChange={(e) =>
                    setDeliveryArea(e.target.value as "inside" | "outside")
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#3a3f2b] font-medium focus:bg-white focus:border-[#3a3f2b] focus:outline-none transition-colors"
                >
                  <option value="inside">ঢাকার ভেতরে (৮০ টাকা)</option>
                  <option value="outside">ঢাকার বাইরে (১৩০ টাকা)</option>
                </select>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3.5 px-4 rounded-xl bg-[#3a3f2b] text-white font-semibold text-sm hover:bg-[#000] transition-all flex items-center justify-center gap-2 shadow-md shadow-[#3a3f2b]/20 disabled:opacity-60"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>অর্ডার প্রসেস হচ্ছে...</span>
                    </>
                  ) : (
                    <>
                      <ShoppingBag className="w-4 h-4" />
                      <span>কনফার্ম অর্ডার (ক্যাশ অন ডেলিভারি)</span>
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
