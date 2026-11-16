import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { systemPageByKey } from "@/lib/seo-pages";
import { emptySeoForm } from "@/features/admin/seo/seo-fields";
import { StaticPageForm } from "@/features/admin/seo/static-page-form";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { getCanonicalOrigin } from "@/server/services/seo.service";
import { adminGetStaticPageBySystemKey } from "@/server/services/admin-cms.service";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "New page · Admin" };

export default async function NewStaticPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const key = typeof sp.system === "string" ? sp.system : undefined;
  const sys = key ? systemPageByKey(key) : undefined;
  if (key && !sys?.cms) notFound();
  if (sys) {
    const existing = await adminGetStaticPageBySystemKey(sys.key);
    if (existing) redirect(`/admin/seo/static-pages/${existing.id}`);
  }
  const [s, origin] = await Promise.all([getStoreSettings(), getCanonicalOrigin()]);
  return (
    <StaticPageForm siteName={s.storeName} origin={origin} path={sys?.path ?? "/pages"}
      initial={{ systemKey: sys?.key, slug: sys?.key ?? "", title: sys?.label ?? "", content: "", isPublished: false, sortOrder: 0, showInFooter: false, seo: emptySeoForm }} />
  );
}
