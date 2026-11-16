import type { Metadata } from "next";
import { SYSTEM_PAGES } from "@/lib/seo-pages";
import { adminListPageSeo } from "@/server/services/admin-cms.service";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { getCanonicalOrigin } from "@/server/services/seo.service";
import { PageSeoEditor } from "@/features/admin/seo/page-seo-editor";

export const metadata: Metadata = { title: "Page SEO · Admin" };

export default async function PageSeoPage() {
  const [rows, s, origin] = await Promise.all([adminListPageSeo(), getStoreSettings(), getCanonicalOrigin()]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">SEO for the built-in pages. Anything left blank falls back to the page&apos;s built-in text, then to the global settings. Product, category and gift-box pages are edited in their own tabs.</p>
      <PageSeoEditor siteName={s.storeName} origin={origin}
        items={SYSTEM_PAGES.map((p) => {
          const r = byKey.get(p.key);
          return { key: p.key, label: p.label, path: p.path, form: {
            title: r?.title ?? "", description: r?.description ?? "", keywords: r?.keywords ?? [], canonical: r?.canonicalUrl ?? "", ogTitle: r?.ogTitle ?? "",
            ogDescription: r?.ogDescription ?? "", image: r?.ogImage ?? "", noindex: r?.noIndex ?? false, nofollow: r?.noFollow ?? false, directives: r?.robotsDirectives ?? "" } };
        })} />
    </div>
  );
}
