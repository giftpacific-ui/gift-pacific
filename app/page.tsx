import Hero from "@/components/Hero";
import FeaturedCombos from "@/components/FeaturedCombos";
import ItemSlider from "@/components/ItemSlider";
import OurBoxes from "@/components/OurBoxes";
import { products, boxTypes } from "@/data/products";
import Link from "next/link";
import { Sparkles, Gift } from "lucide-react";
import TrackPageEvent from "@/components/TrackPageEvent";

export default function HomePage() {
  return (
    <main>
      <TrackPageEvent
        eventName="ViewContent"
        data={{
          content_name: "Home Page",
          content_category: "Landing Page",
        }}
      />
      <Hero />

      {/* Featured Combos */}
      <FeaturedCombos products={products} />

      {/* Individual Item Slider */}
      <ItemSlider products={products} />

      {/* Boxes Section */}
      <OurBoxes boxTypes={boxTypes} />

      {/* Custom Combo Teaser Callout */}
      <section className="py-16 bg-gradient-to-r from-[#f5ede8] via-[#fbf7f4] to-[#f5ede8] border-t border-[#e8dad5]">
        <div className="max-w-5xl mx-auto px-4 text-center space-y-4">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white text-[#3a3f2b] text-xs font-semibold shadow-2xs">
            <Sparkles className="w-3.5 h-3.5" />
            <span>নিজস্ব কাস্টমাইজেশন</span>
          </div>
          <h2 className=" text-2xl sm:text-4xl font-bold text-[#3a3f2b]">
            পছন্দের উপহার দিয়ে নিজেই তৈরি করুন সম্পূর্ণ কম্বো
          </h2>
          <p className="text-sm sm:text-base text-black max-w-2xl mx-auto leading-relaxed">
            যেকোনো পছন্দসই বক্স সিলেক্ট করে সুগন্ধি ক্যান্ডেল, সিরামিক মগ, চকলেট
            বা পার্সোনাল কার্ড দিয়ে আপনার ভালোবাসার মানুষকে দিন অসাধারণ অনুভূতি।
          </p>
          <div className="pt-2">
            <Link
              href="/custom"
              className="inline-flex items-center gap-2 px-8 py-3.5 rounded-xl font-semibold bg-[#3a3f2b] text-white shadow-lg shadow-[#3a3f2b]/20 hover:bg-[#000] transition-all"
            >
              <Gift className="w-4 h-4" />
              <span>এখনই কম্বো তৈরি শুরু করুন</span>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
