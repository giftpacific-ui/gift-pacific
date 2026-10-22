import type { Metadata } from "next";
import { Noto_Sans_Bengali, Playfair_Display } from "next/font/google";
import FacebookPixel from "@/components/FacebookPixel";
import Providers from "@/components/Providers";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import "./globals.css";
import TiktokPixel from "@/components/TiktokPixel";

const notoSansBengali = Noto_Sans_Bengali({
  subsets: ["bengali"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const playfairDisplay = Playfair_Display({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-serif",
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://giftpacific.com";

export const metadata: Metadata = {
  // আপনার রিয়েল প্রোডাকশন ডোমেইন এখানে দিন (কমিট বা আনকমেন্ট করুন)
  metadataBase: new URL(siteUrl),
  title: "Gift Pacific — Premium Handmade Gift & Combo Boxes in Bangladesh",
  description:
    "Gift Pacific - বাংলাদেশের সেরা প্রিমিয়াম হ্যান্ডমেড গিফট, কাস্টম কম্বো বক্স এবং আর্টিস্যানাল ক্রাফট। ক্যাশ অন ডেলিভারিতে সারা দেশে আপনার ভালোবাসার নিখুঁত উপহার পৌঁছে দিন।",
  keywords: [
    "gift box bangladesh",
    "premium gift combo",
    "handmade craft dhaka",
    "custom gift box",
    "gift pacific",
    "anniversary gift",
    "birthday gift box",
  ],
  authors: [{ name: "3rudit3" }],
  openGraph: {
    title: "Gift Pacific — Premium Handmade Gift & Combo Boxes",
    description:
      "প্রিমিয়াম হ্যান্ডমেড গিফট ও কাস্টম কম্বো বক্স। ক্যাশ অন ডেলিভারিতে সারা দেশে পৌঁছে যাচ্ছে আপনার ভালোবাসা।",
    type: "website",
    url: siteUrl,
    siteName: "Gift Pacific",
    images: [
      {
        // এখানে আপনার পাবলিক ফোল্ডারে থাকা আসল ব্র্যান্ড ব্যানার বা লোগো ইমেজ দিন (যেমন: /images/og-cover.jpg)
        url: "/img/logo/og-cover.png",
        width: 1200,
        height: 630,
        alt: "Gift Pacific - Premium Gifts",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Gift Pacific — Premium Handmade Gift & Combo Boxes",
    description: "প্রিমিয়াম হ্যান্ডমেড গিফট ও কাস্টম কম্বো বক্স।",
    images: ["/img/logo/og-cover.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="bn"
      className={`${notoSansBengali.variable} ${playfairDisplay.variable} scroll-smooth`}
    >
      <body
        className="font-[var(--font-sans)] text-[#3a3f2b] min-h-screen flex flex-col antialiased"
        suppressHydrationWarning
      >
        <FacebookPixel />
        <TiktokPixel />
        <Providers>
          <Navbar />
          <div className="flex-1">{children}</div>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
