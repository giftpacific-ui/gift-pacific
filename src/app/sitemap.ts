import type { MetadataRoute } from "next";
import {
  getPageSitemapEntries,
  getProductSitemapEntries,
  getSitemapIds,
} from "@/server/services/sitemap.service";

export const dynamic = "force-dynamic";

export async function generateSitemaps() {
  const ids = await getSitemapIds();
  return ids.map((id) => ({ id: String(id) }));
}

export default async function sitemap({
  id: idPromise,
}: {
  id: Promise<string>;
}): Promise<MetadataRoute.Sitemap> {
  const idStr = await idPromise;
  const id = Number.parseInt(idStr, 10);

  if (!Number.isInteger(id) || id < 0) return [];

  return id === 0 ? getPageSitemapEntries() : getProductSitemapEntries(id - 1);
}
