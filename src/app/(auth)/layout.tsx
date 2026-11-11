import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/config/site";
import { getStoreSettings } from "@/server/services/admin-settings.service";

export const metadata: Metadata = { title: "Account access", robots: { index: false, follow: false } };

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Admin → Settings → store name wins; the built-in brand is only the default.
  const settings = await getStoreSettings();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-sand px-4 py-16">
      <Link href="/" className="mb-8 font-heading text-2xl">
        {settings.storeName || siteConfig.name}
      </Link>
      <div className="w-full max-w-md rounded-2xl border border-border/70 bg-card p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}
