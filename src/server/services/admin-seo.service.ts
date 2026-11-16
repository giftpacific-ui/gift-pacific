import "server-only";
import { prisma } from "@/lib/db/prisma";
import { auditSeoRecord } from "@/lib/seo-rules";
import { SYSTEM_PAGES } from "@/lib/seo-pages";
import { UserFacingError } from "@/lib/errors";

/** Admin-side SEO data access. Validation lives in the action layer (needs the configured origin); this file only reads/writes. */

export const SEO_PAGE_SIZE = 20;
export type EntityKind = "product" | "category" | "box";
export type SeoFilter = "all" | "missing-title" | "missing-description" | "missing-image" | "noindex" | "has-canonical";

export type EntitySeoRow = {
  id: string; name: string; path: string;
  title: string | null; description: string | null; keywords: string[]; image: string | null; noindex: boolean; canonical: string | null;
  /** The record's own SEO image column only (the editor prefills this; `image` may be a display fallback). */
  seoImageOnly: string | null;
  updatedAt: Date;
};

export type EntitySeoInput = {
  title: string | null; description: string | null; keywords: string[]; image: string | null; noindex: boolean; canonical: string | null;
};

type Delegate = {
  findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
  count: (a?: unknown) => Promise<number>;
  update: (a: unknown) => Promise<unknown>;
};

type Cfg = {
  delegate: Delegate; base: Record<string, unknown>; pathPrefix: string;
  f: { title: string; description: string; keywords: string; image: string; noindex: string; canonical: string };
  imageFallback?: string; // column used when no SEO image is set (display only)
};

const cfg = (kind: EntityKind): Cfg => {
  switch (kind) {
    case "product":
      return { delegate: prisma.product as unknown as Delegate, base: { status: "ACTIVE", isBoxProduct: false }, pathPrefix: "/products/",
        f: { title: "metaTitle", description: "metaDescription", keywords: "metaKeywords", image: "seoImage", noindex: "seoNoIndex", canonical: "seoCanonicalUrl" } };
    case "category":
      return { delegate: prisma.category as unknown as Delegate, base: {}, pathPrefix: "/shop/", imageFallback: "image",
        f: { title: "metaTitle", description: "metaDescription", keywords: "metaKeywords", image: "seoImage", noindex: "seoNoIndex", canonical: "seoCanonicalUrl" } };
    case "box":
      return { delegate: prisma.box as unknown as Delegate, base: {}, pathPrefix: "/boxes/", imageFallback: "imageUrl",
        f: { title: "seoTitle", description: "seoDescription", keywords: "seoKeywords", image: "seoImage", noindex: "seoNoIndex", canonical: "seoCanonicalUrl" } };
  }
};

const blank = (field: string) => ({ OR: [{ [field]: null }, { [field]: "" }] });

function whereFor(c: Cfg, q: string, filter: SeoFilter) {
  const and: Record<string, unknown>[] = [c.base];
  if (q.trim()) and.push({ OR: [{ name: { contains: q.trim(), mode: "insensitive" } }, { slug: { contains: q.trim(), mode: "insensitive" } }] });
  if (filter === "missing-title") and.push(blank(c.f.title));
  if (filter === "missing-description") and.push(blank(c.f.description));
  if (filter === "missing-image") and.push(blank(c.f.image));
  if (filter === "noindex") and.push({ [c.f.noindex]: true });
  if (filter === "has-canonical") and.push({ [c.f.canonical]: { not: null } });
  return { AND: and };
}

export async function listEntitySeo(kind: EntityKind, opts: { q?: string; filter?: SeoFilter; page?: number }) {
  const c = cfg(kind);
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const where = whereFor(c, opts.q ?? "", opts.filter ?? "all");
  const [total, rows] = await Promise.all([
    c.delegate.count({ where }),
    c.delegate.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], skip: (page - 1) * SEO_PAGE_SIZE, take: SEO_PAGE_SIZE }),
  ]);
  const items: EntitySeoRow[] = rows.map((r) => ({
    id: String(r.id), name: String(r.name), path: `${c.pathPrefix}${String(r.slug)}`,
    title: (r[c.f.title] as string | null) ?? null, description: (r[c.f.description] as string | null) ?? null,
    keywords: (r[c.f.keywords] as string[] | null) ?? [], image: ((r[c.f.image] as string | null) || (c.imageFallback ? (r[c.imageFallback] as string | null) : null)) ?? null,
    seoImageOnly: (r[c.f.image] as string | null) ?? null,
    noindex: Boolean(r[c.f.noindex]), canonical: (r[c.f.canonical] as string | null) ?? null, updatedAt: r.updatedAt as Date,
  }));
  return { items, total, page, pageCount: Math.max(1, Math.ceil(total / SEO_PAGE_SIZE)) };
}

export async function updateEntitySeo(kind: EntityKind, id: string, input: EntitySeoInput) {
  const c = cfg(kind);
  try {
    await c.delegate.update({
      where: { id },
      data: { [c.f.title]: input.title, [c.f.description]: input.description, [c.f.keywords]: input.keywords, [c.f.image]: input.image, [c.f.noindex]: input.noindex, [c.f.canonical]: input.canonical },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2025") throw new UserFacingError("That record no longer exists.");
    throw e;
  }
}

/* ------------------------------------------------------------ overview */

export type SeoOverview = {
  entities: { kind: EntityKind; label: string; total: number; noTitle: number; noDescription: number; noImage: number; noindex: number; withCanonical: number; duplicateTitles: number }[];
  pages: { total: number; noTitle: number; noDescription: number; noIndex: number };
  cms: { total: number; published: number; noindex: number; noDescription: number };
  redirects: { active: number; inactive: number };
  invalidCanonicals: { kind: string; name: string; value: string }[];
  /** Pages whose own title/description are duplicated across a group (admin-set values only). */
  duplicates: { kind: string; value: string; count: number }[];
};

export async function getSeoOverview(origin: string): Promise<SeoOverview> {
  const kinds: [EntityKind, string][] = [["product", "Products"], ["category", "Categories"], ["box", "Gift boxes"]];
  const entities = await Promise.all(kinds.map(async ([kind, label]) => {
    const c = cfg(kind);
    const w = (extra: Record<string, unknown> = {}) => ({ where: { AND: [c.base, extra] } });
    const [total, noTitle, noDescription, noImage, noindex, withCanonical, dup] = await Promise.all([
      c.delegate.count(w()), c.delegate.count(w(blank(c.f.title))), c.delegate.count(w(blank(c.f.description))), c.delegate.count(w(blank(c.f.image))),
      c.delegate.count(w({ [c.f.noindex]: true })), c.delegate.count(w({ [c.f.canonical]: { not: null } })),
      duplicateGroups(kind),
    ]);
    return { kind, label, total, noTitle, noDescription, noImage, noindex, withCanonical, duplicateTitles: dup.length };
  }));

  const [pageRows, cmsRows, redirectGroups, canonRows] = await Promise.all([
    prisma.pageSeo.findMany({ select: { key: true, title: true, description: true, noIndex: true } }),
    prisma.staticPage.findMany({ select: { isPublished: true, noIndex: true, seoDescription: true } }),
    prisma.redirect.groupBy({ by: ["isActive"], _count: { _all: true } }),
    withCanonicals(),
  ]);
  const byKey = new Map(pageRows.map((r) => [r.key, r]));
  const pages = {
    total: SYSTEM_PAGES.length,
    noTitle: SYSTEM_PAGES.filter((p) => !byKey.get(p.key)?.title?.trim()).length,
    noDescription: SYSTEM_PAGES.filter((p) => !byKey.get(p.key)?.description?.trim()).length,
    noIndex: SYSTEM_PAGES.filter((p) => byKey.get(p.key)?.noIndex).length,
  };
  const cms = {
    total: cmsRows.length, published: cmsRows.filter((r) => r.isPublished).length,
    noindex: cmsRows.filter((r) => r.noIndex).length, noDescription: cmsRows.filter((r) => !r.seoDescription?.trim()).length,
  };
  const invalidCanonicals = canonRows.filter((r) => auditSeoRecord({ title: "x", description: "x", image: "x", canonical: r.value, path: r.path }, origin).includes("invalid-canonical"))
    .map((r) => ({ kind: r.kind, name: r.name, value: r.value }));
  const duplicates = (await Promise.all(kinds.map(async ([kind, label]) => (await duplicateGroups(kind)).map((d) => ({ kind: label, value: d.value, count: d.count })))))
    .flat().slice(0, 25);
  const act = (b: boolean) => redirectGroups.find((g) => g.isActive === b)?._count._all ?? 0;
  return { entities, pages, cms, redirects: { active: act(true), inactive: act(false) }, invalidCanonicals: invalidCanonicals.slice(0, 50), duplicates };
}

/** Admin-set titles shared by 2+ records (GROUP BY in the database; no catalog load). */
async function duplicateGroups(kind: EntityKind): Promise<{ value: string; count: number }[]> {
  const c = cfg(kind);
  const delegate = c.delegate as unknown as { groupBy: (a: unknown) => Promise<Record<string, unknown>[]> };
  const rows = await delegate.groupBy({
    by: [c.f.title],
    where: { AND: [c.base, { [c.f.title]: { not: null } }, { NOT: { [c.f.title]: "" } }] },
    _count: { _all: true },
    having: { [c.f.title]: { _count: { gt: 1 } } },
    orderBy: { _count: { [c.f.title]: "desc" } },
    take: 25,
  });
  return rows.map((r) => ({ value: String(r[c.f.title]), count: (r._count as { _all: number })._all }));
}

async function withCanonicals() {
  const out: { kind: string; name: string; value: string; path: string }[] = [];
  for (const kind of ["product", "category", "box"] as EntityKind[]) {
    const c = cfg(kind);
    const rows = await c.delegate.findMany({ where: { AND: [c.base, { [c.f.canonical]: { not: null } }] }, take: 500, select: { name: true, slug: true, [c.f.canonical]: true } });
    for (const r of rows) out.push({ kind, name: String(r.name), value: String(r[c.f.canonical]), path: `${c.pathPrefix}${String(r.slug)}` });
  }
  return out;
}
