"use client";

import Link from "next/link";
import { Package, Heart, Phone, Mail } from "lucide-react";
import Image from "next/image";

export default function Footer() {
  return (
    <footer className="bg-[#faf4ec]/10 border-t border-[#e8dad5] pt-14 pb-8 text-[#3a3f2b]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 pb-12 border-b border-[#e8dad5]/70">
          {/* Brand Info */}
          <div className="md:col-span-5 space-y-4">
            <Link
              href="/"
              className="flex items-center"
            >
              <Image
                src="/img/logo/logo.png"
                width={180}
                height={36}
                alt="Gift Pacific Logo"
              />
            </Link>
            <p className="text-xs sm:text-sm text-black leading-relaxed max-w-sm">
              বাংলাদেশের সেরা প্রিমিয়াম হ্যান্ডমেড ক্রাফট ও কাস্টমাইজড কম্বো
              গিফট বক্স। ভালোবাসা প্রকাশের প্রতিটি মুহূর্তকে নিখুঁত ও
              অবিস্মরণীয় করে তুলতে আমরা বদ্ধপরিকর।
            </p>
            <div className="pt-2 text-xs text-black flex items-center gap-1.5">
              <span>Made with care</span>
              <Heart className="w-3.5 h-3.5 text-[#3a3f2b] fill-current" />
              <span>in Bangladesh</span>
            </div>
          </div>

          {/* Quick Links */}
          <div className="md:col-span-3 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#3a3f2b]">
              দ্রুত লিঙ্কসমূহ
            </h4>
            <ul className="space-y-2 text-xs sm:text-sm text-black">
              <li>
                <Link
                  href="/"
                  className="hover:text-[#3a3f2b] transition-colors"
                >
                  হোম
                </Link>
              </li>
              <li>
                <Link
                  href="/boxes"
                  className="hover:text-[#3a3f2b] transition-colors"
                >
                  আমাদের বক্স
                </Link>
              </li>
              <li>
                <Link
                  href="/shop"
                  className="hover:text-[#3a3f2b] transition-colors"
                >
                  শপ কালেকশন
                </Link>
              </li>
              <li>
                <Link
                  href="/custom"
                  className="hover:text-[#3a3f2b] transition-colors"
                >
                  নিজে বানান কম্বো
                </Link>
              </li>
              <li>
                <Link
                  href="/about"
                  className="hover:text-[#3a3f2b] transition-colors"
                >
                  আমাদের সম্পর্কে
                </Link>
              </li>
              <li>
                <Link
                  href="/contact"
                  className="hover:text-[#3a3f2b] transition-colors"
                >
                  যোগাযোগ
                </Link>
              </li>
            </ul>
          </div>

          {/* Contact and Support */}
          <div className="md:col-span-4 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#3a3f2b]">
              সহায়তা ও হটলাইন
            </h4>
            <div className="space-y-2.5 text-xs sm:text-sm text-black">
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-[#3a3f2b] shrink-0" />
                <a href="tel:+8801308050850" className="hover:text-[#3a3f2b]">
                  +880 1308 050850
                </a>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-[#3a3f2b] shrink-0" />
                <a
                  href="mailto:giftpacific@gmail.com।"
                  className="hover:text-[#3a3f2b]"
                >
                  giftpacific@gmail.com
                </a>
              </div>
              <div className="p-3 rounded-xl bg-[#fbf7f4] border border-[#e8dad5] text-xs text-[#3a3f2b] mt-3">
                <span className="font-semibold block text-[#3a3f2b]">
                  🚚 ক্যাশ অন ডেলিভারি সার্ভিস
                </span>
                ঢাকার ভেতরে ৮০ টাকা, ঢাকার বাইরে ১৩০ টাকা ডেলিভারি চার্জ।
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between text-xs text-black gap-4">
          <div>
            © {new Date().getFullYear()} Gift Pacific — সর্বস্বত্ব সংরক্ষিত।
          </div>
          <div className="flex items-center gap-4">
            <span>ক্যাশ অন ডেলিভারি</span>
            <span>•</span>
            <span>১০০% প্রিমিয়াম কোয়ালিটি</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
