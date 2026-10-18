"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Sparkles,
  ShieldCheck,
  Truck,
  HeartHandshake,
} from "lucide-react";

export default function Hero() {
  return (
    <section className="relative overflow-hidden pt-8 pb-16 lg:py-20">
      {/* Background radial blurs */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-[#0053a8]/10 rounded-full blur-3xl -z-10 pointer-events-none" />
      <div className="absolute bottom-0 right-10 w-96 h-96 bg-[#e8dad5]/60 rounded-full blur-3xl -z-10 pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          {/* Left Content */}
          <div className="lg:col-span-7 space-y-6 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#f5ede8] border border-[#e8dad5] text-xs font-semibold text-[#0053a8]">
              <Sparkles className="w-3.5 h-3.5" />
              <span>প্রিমিয়াম হ্যান্ডমেড ক্রাফট & গিফট বক্স</span>
            </div>

            <h1 className=" text-3xl sm:text-4xl lg:text-[56px] font-extrabold tracking-tight text-[#4a3b3b] leading-[1.2]">
              খুলে দিন আনন্দের{" "}
              <span className="text-[#0053a8] italic">Gift Pacific</span>,{" "}
              <br />
              কারণ ভালো থাকার প্রতিটি মুহূর্তের যত্ন প্রয়োজন।
            </h1>

            <p className="text-base sm:text-lg text-[#8a7a7a] max-w-2xl mx-auto lg:mx-0 leading-relaxed font-normal">
              হ্যান্ডমেড ক্রাফট, প্রিমিয়াম কম্বো এবং নিখুঁত প্যাকেজিং। প্রিয়জনের
              জন্মদিন, বিবাহবার্ষিকী কিংবা বিশেষ দিনে ক্যাশ অন ডেলিভারিতে সারা
              দেশে পৌঁছে যাচ্ছে আপনার নিখুঁত ভালোবাসা।
            </p>

            {/* CTAs with Next.js Link */}
            <div className="flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-3.5 pt-2">
              <Link
                href="/shop"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl font-semibold bg-[#0053a8] text-white shadow-lg shadow-[#0053a8]/25 hover:bg-[#e34d01] hover:shadow-xl hover:shadow-[#0053a8]/35 hover:-translate-y-0.5 transition-all"
              >
                <span>কালেকশন দেখুন</span>
                <ArrowRight className="w-4 h-4" />
              </Link>

              <Link
                href="/custom"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold border-2 border-[#0053a8] text-[#0053a8] hover:bg-[#0053a8] hover:text-white transition-all"
              >
                <Sparkles className="w-4 h-4" />
                <span>নিজে কম্বো বানান</span>
              </Link>
            </div>

            {/* Trust Badges */}
            <div className="pt-8 grid grid-cols-3 gap-3 border-t border-[#e8dad5]/80 max-w-xl mx-auto lg:mx-0">
              <div className="flex items-center gap-2 justify-center lg:justify-start text-left">
                <Truck className="w-5 h-5 text-[#0053a8] shrink-0" />
                <span className="text-xs text-[#4a3b3b] font-medium leading-tight">
                  ক্যাশ অন ডেলিভারি
                </span>
              </div>
              <div className="flex items-center gap-2 justify-center lg:justify-start text-left">
                <ShieldCheck className="w-5 h-5 text-[#0053a8] shrink-0" />
                <span className="text-xs text-[#4a3b3b] font-medium leading-tight">
                  ১০০% কোয়ালিটি গার্ড
                </span>
              </div>
              <div className="flex items-center gap-2 justify-center lg:justify-start text-left">
                <HeartHandshake className="w-5 h-5 text-[#0053a8] shrink-0" />
                <span className="text-xs text-[#4a3b3b] font-medium leading-tight">
                  কাস্টমাইজড চিঠি
                </span>
              </div>
            </div>
          </div>

          {/* Right Visual Image */}
          <div className="lg:col-span-5 flex justify-center">
            <div className="relative w-full max-w-md">
              <div className="relative aspect-[4/4.5] rounded-3xl overflow-hidden shadow-2xl shadow-[#0053a8]/15 border-4 border-white">
                <Image
                  src="https://images.unsplash.com/photo-1607344645866-009c320b63e0?q=80&w=800&auto=format&fit=crop"
                  alt="Gift Pacific Premium Gift Box"
                  fill
                  sizes="(max-width: 768px) 100vw, 450px"
                  className="object-cover hover:scale-105 transition-transform duration-700"
                  priority
                  referrerPolicy="no-referrer"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />

                {/* Floating pill badge */}
                <div className="absolute bottom-4 left-4 right-4 bg-white/95 backdrop-blur-md p-3.5 rounded-2xl shadow-lg border border-[#e8dad5] flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-[#0053a8] uppercase tracking-wider">
                      স্পেশাল প্যাকেজিং
                    </div>
                    <div className=" text-sm font-bold text-[#4a3b3b]">
                      হ্যান্ডমেড কিউরেটেড বক্স
                    </div>
                  </div>
                  <span className="px-2.5 py-1 text-xs font-bold rounded-lg bg-[#f5ede8] text-[#0053a8]">
                    সারপ্রাইজ রেডি
                  </span>
                </div>
              </div>

              {/* Decorative accent behind */}
              <div className="absolute -bottom-4 -right-4 w-32 h-32 bg-[#0053a8]/20 rounded-full blur-xl -z-10" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
