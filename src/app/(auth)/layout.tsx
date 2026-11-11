import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/config/site";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Account access",
  robots: { index: false, follow: false },
};

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Admin → Settings → store name wins; the built-in brand is only the default.
  const settings = await getStoreSettings();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-16 relative">
      <Image
        src="/img/login-bg.png"
        alt="Login background"
        fill
        priority
        className="object-cover -z-25 transition-all duration-700 ease-in-out"
      />

      {/* Lighter Overlay so background branding/logo remains visible */}
      <div className="absolute inset-0 bg-background/40 -z-20" />
      <Link href="/" className="mb-8 font-heading text-2xl">
        {settings.storeName || siteConfig.name}
      </Link>
      <div className="w-full max-w-md rounded-2xl border border-border/70 bg-card p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}
