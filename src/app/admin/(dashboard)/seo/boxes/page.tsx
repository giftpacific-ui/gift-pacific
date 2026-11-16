import type { Metadata } from "next";
import { EntitySeoList } from "@/features/admin/seo/entity-seo-list";
import { firstParam, pageParam } from "@/features/admin/seo/seo-pager";
import type { SeoFilter } from "@/server/services/admin-seo.service";

export const metadata: Metadata = { title: "Gift boxes SEO · Admin" };

export default async function BoxesSeoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <EntitySeoList kind="box" action="/admin/seo/boxes" q={firstParam(sp.q)} filter={(firstParam(sp.filter) || "all") as SeoFilter} page={pageParam(sp.page)} />;
}
