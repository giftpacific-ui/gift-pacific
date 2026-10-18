"use client";

import Image from "next/image";
import { teamMembers } from "@/data/products";
import { Sparkles, Palette, HeartHandshake, ExternalLink } from "lucide-react";

export default function AboutSection() {
  const values = [
    {
      icon: Sparkles,
      title: "নিখুঁত কোয়ালিটি",
      desc: "আমরা প্রতিটি প্রোডাক্ট বাছাই ও তৈরি করি সর্বোচ্চ মান নিশ্চিত করে। প্রিমিয়াম ফিনিশিং এবং সেরা উপকরণের ব্যবহারই আমাদের মূল শক্তি।",
    },
    {
      icon: Palette,
      title: "এক্সক্লুসিভ ডিজাইন",
      desc: "প্রতিটি কম্বো বক্স ডিজাইন করা হয় স্বতন্ত্র সৌন্দর্যের চিন্তা থেকে। আপনার উপহার হবে একমাত্র, ঠিক যেমনটা আপনি চান।",
    },
    {
      icon: HeartHandshake,
      title: "যত্নশীল পরিবেশন",
      desc: "অর্ডার থেকে ডেলিভারি—প্রতিটি ধাপে আমরা নিশ্চিত করি নিরবচ্ছিন্ন সেবা। আপনার সন্তুষ্টিই আমাদের চূড়ান্ত লক্ষ্য।",
    },
  ];

  return (
    <section className="py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Story Intro */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <span className="text-xs font-bold text-[#0053a8] uppercase tracking-widest">
            Our Heritage & Passion
          </span>
          <h2 className=" text-3xl sm:text-4xl font-extrabold text-[#4a3b3b] mt-2 mb-6">
            ক্রাফটিং মেমোরিজ,{" "}
            <span className="text-[#0053a8] italic">অ্যাট Gift Pacific</span>
          </h2>
          <p className="text-base text-[#8a7a7a] leading-relaxed">
            Gift Pacific শুধু একটি গিফট ব্র্যান্ড নয়; এটি নিখুঁত প্রিজেন্টেশন
            এবং স্মৃতি তৈরির প্রতিশ্রুতি। আমরা বিশ্বাস করি, সেরা উপহারগুলো কেবল
            বস্তু দিয়ে তৈরি হয় না, বরং যত্ন, নকশা এবং आबेगের निखुँत समन्वये
            गड़े ओठে।
          </p>
          <p className="text-base text-[#8a7a7a] leading-relaxed mt-4">
            চারজন পার্টনারের একটি যৌথ উদ্যোগে শুরু হওয়া এই যাত্রা, আজ প্রিমিয়াম
            হ্যান্ডমেড ক্রাফট এবং কাস্টমাইজড কম্বো বক্সের একটি বিশ্বস্ত ঠিকানা।
            প্রতিটি পার্সেল আমরা তৈরি করি সর্বোচ্চ মানের উপকরণ এবং নিঁখুত
            প্যাকেজিংয়ের মাধ্যমে, যেন আপনার ভালোবাসার প্রতিটি মুহূর্ত হয় আরও
            বিশেষ।
          </p>
        </div>

        {/* 3 Value Pillars */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-20">
          {values.map((v, idx) => {
            const Icon = v.icon;
            return (
              <div
                key={idx}
                className="bg-gradient-to-b from-white to-[#f5ede8]/30 rounded-2xl border border-[#e8dad5] p-8 text-center hover:shadow-lg hover:shadow-[#0053a8]/10 transition-all duration-300 hover:-translate-y-1"
              >
                <div className="w-14 h-14 rounded-2xl bg-white border border-[#e8dad5] shadow-xs text-[#0053a8] flex items-center justify-center mx-auto mb-5">
                  <Icon className="w-7 h-7" />
                </div>
                <h3 className=" text-xl font-bold text-[#4a3b3b] mb-3">
                  {v.title}
                </h3>
                <p className="text-xs sm:text-sm text-[#8a7a7a] leading-relaxed">
                  {v.desc}
                </p>
              </div>
            );
          })}
        </div>

        {/* Meet The Partners */}
        <div className="text-center max-w-xl mx-auto mb-10">
          <span className="text-xs font-bold text-[#0053a8] uppercase tracking-widest">
            Meet The Partners
          </span>
          <h2 className=" text-2xl sm:text-3xl font-bold text-[#4a3b3b] mt-1">
            আমাদের দূরদর্শী <span className="text-[#0053a8]">টিম</span>
          </h2>
          <p className="text-xs sm:text-sm text-[#8a7a7a] mt-2">
            প্রতিটি অর্ডার নিখুঁতভাবে আপনার দ্বারে পৌঁছে দিতে একসাথে কাজ করছে
            আমাদের টিম
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {teamMembers.map((member, idx) => (
            <div
              key={idx}
              className="bg-white rounded-2xl border border-[#e8dad5] overflow-hidden shadow-xs hover:shadow-xl hover:shadow-[#0053a8]/10 hover:border-[#0053a8] transition-all duration-300 hover:-translate-y-1 flex flex-col justify-between group"
            >
              <div>
                <div className="relative aspect-square w-full bg-[#f5ede8] overflow-hidden">
                  <Image
                    src={member.img}
                    alt={member.name}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                    className="object-cover group-hover:scale-105 transition-transform duration-500 filter grayscale-20 group-hover:grayscale-0"
                    referrerPolicy="no-referrer"
                  />
                  {member.link && (
                    <a
                      href={member.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="absolute top-3 right-3 p-1.5 rounded-lg bg-white/90 text-[#4a3b3b] hover:text-[#0053a8] shadow-xs transition-colors"
                      aria-label={`${member.name} profile`}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>

                <div className="p-5 text-center">
                  <h3 className=" text-lg font-bold text-[#4a3b3b]">
                    {member.name}
                  </h3>
                  <div className="text-[11px] font-bold text-[#0053a8] uppercase tracking-wider mt-0.5 mb-2.5">
                    {member.role}
                  </div>
                  <p className="text-xs text-[#8a7a7a] leading-relaxed">
                    {member.desc}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
