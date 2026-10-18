"use client";

import { useState } from "react";
import { getDeviceInfo } from "@/lib/utils";
import { trackPixelEvent } from "@/lib/analytics";
import {
  Phone,
  Mail,
  Send,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Facebook,
  Instagram,
} from "lucide-react";
import { FaTiktok } from "react-icons/fa";

export default function ContactSection() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setStatus("idle");

    const contactPayload = {
      type: "contact",
      name,
      phone,
      message,
      device: getDeviceInfo(),
      location: "Fetching...",
    };

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contactPayload),
      });

      if (!res.ok) throw new Error("Failed to send");

      trackPixelEvent("Lead", {
        content_name: "Contact Inquiry",
      });

      setStatus("success");
      setName("");
      setPhone("");
      setMessage("");
    } catch (err) {
      console.error("Contact error:", err);
      setStatus("error");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
          {/* Left Info */}
          <div className="lg:col-span-5 space-y-6">
            <div>
              <span className="text-xs font-bold text-[#0053a8] uppercase tracking-widest">
                Get In Touch
              </span>
              <h2 className=" text-3xl font-bold text-[#4a3b3b] mt-1 mb-3">
                যোগাযোগ করুন
              </h2>
              <p className="text-sm text-[#8a7a7a] leading-relaxed">
                আপনার কোনো বিশেষ কাস্টম অর্ডারের চাহিদা বা যেকোনো তথ্য জানার
                থাকলে নির্দ্বিধায় আমাদের মেসেজ পাঠান। আমাদের টিম ২৪ ঘণ্টার
                মধ্যে আপনার সাথে যোগাযোগ করবে।
              </p>
            </div>

            <div className="space-y-4">
              <a
                href="tel:+8801308050850"
                className="flex items-center gap-4 p-4 rounded-2xl bg-white border border-[#e8dad5] hover:border-[#0053a8] transition-all group shadow-xs"
              >
                <div className="w-12 h-12 rounded-xl bg-[#f5ede8] text-[#0053a8] flex items-center justify-center shrink-0 group-hover:bg-[#0053a8] group-hover:text-white transition-colors">
                  <Phone className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-[#8a7a7a]">হটলাইন কল</div>
                  <div className="text-sm font-bold text-[#4a3b3b] group-hover:text-[#0053a8] transition-colors">
                    +880 1308050850
                  </div>
                </div>
              </a>

              <a
                href="mailto:giftpacific@gmail.com"
                className="flex items-center gap-4 p-4 rounded-2xl bg-white border border-[#e8dad5] hover:border-[#0053a8] transition-all group shadow-xs"
              >
                <div className="w-12 h-12 rounded-xl bg-[#f5ede8] text-[#0053a8] flex items-center justify-center shrink-0 group-hover:bg-[#0053a8] group-hover:text-white transition-colors">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-[#8a7a7a]">ইমেইল সাপোর্ট</div>
                  <div className="text-sm font-bold text-[#4a3b3b] group-hover:text-[#0053a8] transition-colors">
                    giftpacific@gmail.com
                  </div>
                </div>
              </a>

              {/* Social Media Links */}
              <div className="grid grid-cols-3 gap-3 pt-2">
                <a
                  href="https://facebook.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col items-center justify-center gap-2 p-3 rounded-2xl bg-white border border-[#e8dad5] hover:border-[#0053a8] transition-all group shadow-xs"
                >
                  <div className="w-10 h-10 rounded-xl bg-[#f5ede8] text-[#0053a8] flex items-center justify-center group-hover:bg-[#0053a8] group-hover:text-white transition-colors">
                    <Facebook className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-semibold text-[#4a3b3b] group-hover:text-[#0053a8]">
                    Facebook
                  </span>
                </a>

                <a
                  href="https://instagram.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col items-center justify-center gap-2 p-3 rounded-2xl bg-white border border-[#e8dad5] hover:border-[#0053a8] transition-all group shadow-xs"
                >
                  <div className="w-10 h-10 rounded-xl bg-[#f5ede8] text-[#0053a8] flex items-center justify-center group-hover:bg-[#0053a8] group-hover:text-white transition-colors">
                    <Instagram className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-semibold text-[#4a3b3b] group-hover:text-[#0053a8]">
                    Instagram
                  </span>
                </a>

                <a
                  href="https://tiktok.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col items-center justify-center gap-2 p-3 rounded-2xl bg-white border border-[#e8dad5] hover:border-[#0053a8] transition-all group shadow-xs"
                >
                  <div className="w-10 h-10 rounded-xl bg-[#f5ede8] text-[#0053a8] flex items-center justify-center group-hover:bg-[#0053a8] group-hover:text-white transition-colors">
                    <FaTiktok className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-semibold text-[#4a3b3b] group-hover:text-[#0053a8]">
                    TikTok
                  </span>
                </a>
              </div>
            </div>
          </div>

          {/* Right Form */}
          <div className="lg:col-span-7 bg-white rounded-3xl border border-[#e8dad5] p-6 sm:p-8 shadow-sm">
            <h3 className=" text-xl font-bold text-[#4a3b3b] mb-1">
              আমাদের একটি বার্তা পাঠান
            </h3>
            <p className="text-xs text-[#8a7a7a] mb-6">
              নিচের ফর্মটি পূরণ করে পাঠান, দ্রুততম সময়ে আমরা উত্তর দেব।
            </p>

            {status === "success" && (
              <div className="mb-6 p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-600" />
                <span>
                  আপনার বার্তা সফলভাবে পাঠানো হয়েছে! আমাদের টিম শীঘ্রই আপনার
                  সাথে যোগাযোগ করবে।
                </span>
              </div>
            )}

            {status === "error" && (
              <div className="mb-6 p-4 rounded-2xl bg-red-50 border border-red-200 text-red-800 text-xs flex items-center gap-3">
                <AlertCircle className="w-5 h-5 shrink-0 text-red-600" />
                <span>
                  বার্তা পাঠানো যায়নি, অনুগ্রহ করে আবার চেষ্টা করুন বা ফোনে
                  যোগাযোগ করুন।
                </span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#4a3b3b] mb-1.5">
                  আপনার নাম <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="আপনার নাম লিখুন"
                  className="w-full px-4 py-2.5 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#4a3b3b] focus:bg-white focus:border-[#0053a8] focus:outline-none transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#4a3b3b] mb-1.5">
                  মোবাইল নম্বর <span className="text-red-500">*</span>
                </label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="01XXXXXXXXX"
                  className="w-full px-4 py-2.5 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#4a3b3b] focus:bg-white focus:border-[#0053a8] focus:outline-none transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#4a3b3b] mb-1.5">
                  আপনার বার্তা <span className="text-red-500">*</span>
                </label>
                <textarea
                  required
                  rows={4}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="আপনার কাঙ্ক্ষিত উপহার, বিশেষ চাহিদা বা কোনো প্রশ্ন থাকলে লিখুন..."
                  className="w-full px-4 py-2.5 rounded-xl border border-[#e8dad5] bg-[#fbf7f4] text-sm text-[#4a3b3b] focus:bg-white focus:border-[#0053a8] focus:outline-none transition-colors resize-none"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3.5 px-4 rounded-xl bg-[#0053a8] text-white font-semibold text-sm hover:bg-[#e34d01] transition-all flex items-center justify-center gap-2 shadow-md shadow-[#0053a8]/20 disabled:opacity-60"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>পাঠানো হচ্ছে...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    <span>মেসেজ পাঠান</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}
