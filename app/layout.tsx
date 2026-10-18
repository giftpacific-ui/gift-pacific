import type { Metadata } from "next";
import { Hind_Siliguri, Playfair_Display } from "next/font/google";
import FacebookPixel from "@/components/FacebookPixel";
import Providers from "@/components/Providers";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import "./globals.css";

const hindSiliguri = Hind_Siliguri({
  subsets: ["bengali", "latin"],
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

export const metadata: Metadata = {
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
    images: [
      {
        url: "https://images.unsplash.com/photo-1607344645866-009c320b63e0?q=80&w=1200&auto=format&fit=crop",
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
    images: [
      "https://images.unsplash.com/photo-1607344645866-009c320b63e0?q=80&w=1200&auto=format&fit=crop",
    ],
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
      className={`${hindSiliguri.variable} ${playfairDisplay.variable} scroll-smooth`}
    >
      <body
        className="font-[var(--font-sans)] bg-[#fbf7f4] text-[#4a3b3b] min-h-screen flex flex-col antialiased"
        suppressHydrationWarning
      >
        <FacebookPixel />
        <Providers>
          <Navbar />
          <div className="flex-1">{children}</div>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
