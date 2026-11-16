import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { staticPagePath } from "@/lib/seo-pages";
import { StaticPageForm } from "@/features/admin/seo/static-page-form";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { getCanonicalOrigin } from "@/server/services/seo.service";
import { adminGetStaticPage } from "@/server/services/admin-cms.service";

export const metadata: Metadata = { title: "Edit page · Admin" };

export default async function EditStaticPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [p, s, origin] = await Promise.all([adminGetStaticPage(id), getStoreSettings(), getCanonicalOrigin()]);
  if (!p) notFound();
  return (
    <StaticPageForm siteName={s.storeName} origin={origin} path={staticPagePath(p)}
      initial={{
        id: p.id, systemKey: p.systemKey ?? undefined, slug: p.slug, title: p.title, content: p.content, isPublished: p.isPublished, sortOrder: p.sortOrder, showInFooter: p.showInFooter,
        seo: { title: p.seoTitle ?? "", description: p.seoDescription ?? "", keywords: p.seoKeywords, canonical: p.canonicalUrl ?? "", ogTitle: "", ogDescription: "", image: p.ogImage ?? "", noindex: p.noIndex, nofollow: p.noFollow, directives: p.robotsDirectives ?? "" },
      }} />
  );
}
