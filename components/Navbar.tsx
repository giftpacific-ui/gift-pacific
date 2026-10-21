"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Package, Menu, X, Sparkles } from "lucide-react";
import { useCart } from "@/context/CartContext";
import Image from "next/image";

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const { totalCustomCartItems } = useCart();

  const navLinks = [
    { href: "/", label: "হোম" },
    { href: "/boxes", label: "আমাদের বক্স" },
    { href: "/shop", label: "শপ" },
    {
      href: "/custom",
      label: "নিজে কম্বো বানান",
      badge: totalCustomCartItems > 0 ? totalCustomCartItems : null,
    },
    { href: "/about", label: "আমাদের সম্পর্কে" },
    { href: "/contact", label: "যোগাযোগ" },
  ];

  return (
    <>
      <header className="sticky top-0 z-40 bg-[#fbf7f4]/90 backdrop-blur-md border-b border-[#e8dad5] transition-all">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-20">
            {/* Brand Logo */}
            <Link href="/" className="flex items-center">
              <Image
                src="/img/logo/logo.png"
                width={180}
                height={36}
                alt="Gift Pacific Logo"
              />
            </Link>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-1 lg:gap-2">
              {navLinks.map((link) => {
                const isActive =
                  link.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(link.href);

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`relative px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
                      isActive
                        ? "text-[#3a3f2b] bg-[#f5ede8] font-semibold"
                        : "text-black hover:text-[#3a3f2b] hover:bg-[#f5ede8]/60"
                    }`}
                  >
                    <span>{link.label}</span>
                    {link.badge !== null && link.badge !== undefined && (
                      <span className="ml-1.5 px-1.5 py-0.5 text-[11px] font-bold rounded-full bg-[#3a3f2b] text-white">
                        {link.badge}
                      </span>
                    )}
                    {isActive && (
                      <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-[#3a3f2b] rounded-full" />
                    )}
                  </Link>
                );
              })}
            </nav>

            {/* Quick Action Button & Mobile Toggle */}
            <div className="flex items-center gap-3">
              <Link
                href="/custom"
                className="hidden sm:inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#3a3f2b] text-white shadow-sm hover:bg-[#000] transition-all hover:shadow-md hover:shadow-[#3a3f2b]/20"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>কম্বো তৈরি করুন</span>
              </Link>

              <button
                onClick={() => setMobileOpen(!mobileOpen)}
                aria-label="Toggle navigation menu"
                className="md:hidden p-2 rounded-lg text-[#3a3f2b] hover:bg-[#f5ede8] transition-colors"
              >
                {mobileOpen ? (
                  <X className="w-6 h-6" />
                ) : (
                  <Menu className="w-6 h-6" />
                )}
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile Drawer Overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-[#3a3f2b]/40 backdrop-blur-xs z-50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile Drawer Menu */}
      <div
        className={`fixed top-0 right-0 bottom-0 w-72 bg-white z-50 shadow-2xl flex flex-col transition-transform duration-300 ease-out md:hidden ${
          mobileOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="p-5 flex items-center justify-between border-b border-[#e8dad5]">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#3a3f2b] flex items-center justify-center text-white">
              <Package className="w-4 h-4" />
            </div>
            <span className=" font-bold text-lg text-[#3a3f2b]">
              Gift Pacific
            </span>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="p-1.5 rounded-lg text-black hover:bg-[#f5ede8]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-1">
          {navLinks.map((link) => {
            const isActive =
              link.href === "/"
                ? pathname === "/"
                : pathname.startsWith(link.href);

            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-left font-medium transition-all ${
                  isActive
                    ? "bg-[#f5ede8] text-[#3a3f2b] font-bold"
                    : "text-[#3a3f2b] hover:bg-[#f5ede8]/50"
                }`}
              >
                <span>{link.label}</span>
                {link.badge !== null && link.badge !== undefined && (
                  <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-[#3a3f2b] text-white">
                    {link.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t border-[#e8dad5] bg-[#fbf7f4]">
          <Link
            href="/custom"
            onClick={() => setMobileOpen(false)}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-[#3a3f2b] text-white font-medium shadow-sm hover:bg-[#000] transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            <span>নিজে কম্বো বানান</span>
          </Link>
          <div className="mt-3 text-center text-xs text-black">
            ক্যাশ অন ডেলিভারিতে সারা বাংলাদেশে
          </div>
        </div>
      </div>
    </>
  );
}
