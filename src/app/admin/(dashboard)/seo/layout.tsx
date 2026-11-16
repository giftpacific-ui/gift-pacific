import type { ReactNode } from "react";
import { SeoNav } from "@/features/admin/seo/seo-nav";

export default function SeoLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h1 className="font-heading text-2xl">SEO</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">Control how pages appear in search results and when shared. Changes apply to the storefront as soon as they are saved; search engines pick them up on their own schedule.</p>
      <div className="pt-3"><SeoNav /></div>
      {children}
    </div>
  );
}
