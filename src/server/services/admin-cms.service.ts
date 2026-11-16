import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { detectRedirectLoop } from "@/lib/redirect-rules";

const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
const isMissing = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2025";

/* ------------------------------------------------------------ Page SEO */

export type PageSeoInput = {
  title: string | null; description: string | null; keywords: string[]; canonicalUrl: string | null; ogTitle: string | null;
  ogDescription: string | null; ogImage: string | null; noIndex: boolean; noFollow: boolean; robotsDirectives: string | null;
};

export const adminListPageSeo = () => prisma.pageSeo.findMany();
export const adminUpsertPageSeo = (key: string, d: PageSeoInput) => prisma.pageSeo.upsert({ where: { key }, update: d, create: { key, ...d } });

/* ------------------------------------------------------- Static pages */

export type StaticPageInput = {
  slug: string; title: string; content: string; isPublished: boolean; sortOrder: number; showInFooter: boolean;
  seoTitle: string | null; seoDescription: string | null; seoKeywords: string[]; canonicalUrl: string | null; ogImage: string | null;
  noIndex: boolean; noFollow: boolean; robotsDirectives: string | null;
};

export async function adminListStaticPages(opts: { q?: string; page?: number; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 20;
  const page = Math.max(1, opts.page ?? 1);
  const where = opts.q?.trim() ? { OR: [{ title: { contains: opts.q.trim(), mode: "insensitive" as const } }, { slug: { contains: opts.q.trim(), mode: "insensitive" as const } }] } : {};
  const [total, items] = await Promise.all([
    prisma.staticPage.count({ where }),
    prisma.staticPage.findMany({ where, orderBy: [{ sortOrder: "asc" }, { title: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export const adminGetStaticPage = (id: string) => prisma.staticPage.findUnique({ where: { id } });
export const adminGetStaticPageBySystemKey = (systemKey: string) => prisma.staticPage.findUnique({ where: { systemKey } });
export const adminSystemStaticPages = () => prisma.staticPage.findMany({ where: { systemKey: { not: null } }, select: { id: true, systemKey: true, isPublished: true, updatedAt: true } });

export async function adminCreateStaticPage(input: StaticPageInput, systemKey?: string) {
  try {
    return await prisma.staticPage.create({ data: { ...input, systemKey: systemKey ?? null, publishedAt: input.isPublished ? new Date() : null } });
  } catch (e) {
    if (isUnique(e)) throw new UserFacingError("A page with that slug already exists.");
    throw e;
  }
}

export async function adminUpdateStaticPage(id: string, input: StaticPageInput) {
  const existing = await prisma.staticPage.findUnique({ where: { id }, select: { slug: true, systemKey: true, publishedAt: true, isPublished: true } });
  if (!existing) throw new UserFacingError("That page no longer exists.");
  // A system page keeps its slug (its URL is fixed by the built-in route).
  const slug = existing.systemKey ? existing.slug : input.slug;
  try {
    return await prisma.staticPage.update({
      where: { id },
      data: { ...input, slug, publishedAt: input.isPublished ? (existing.publishedAt ?? new Date()) : existing.publishedAt },
    });
  } catch (e) {
    if (isUnique(e)) throw new UserFacingError("A page with that slug already exists.");
    if (isMissing(e)) throw new UserFacingError("That page no longer exists.");
    throw e;
  }
}

/** Deleting a system-keyed page only removes the override: the built-in content of that route is untouched. */
export async function adminDeleteStaticPage(id: string) {
  try {
    await prisma.staticPage.delete({ where: { id } });
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
}

/* ----------------------------------------------------------- Redirects */

export async function adminListRedirects(opts: { q?: string; status?: "all" | "active" | "inactive"; page?: number; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 25;
  const page = Math.max(1, opts.page ?? 1);
  const and: Record<string, unknown>[] = [];
  if (opts.q?.trim()) and.push({ OR: [{ fromPath: { contains: opts.q.trim(), mode: "insensitive" } }, { toPath: { contains: opts.q.trim(), mode: "insensitive" } }] });
  if (opts.status === "active") and.push({ isActive: true });
  if (opts.status === "inactive") and.push({ isActive: false });
  const where = and.length ? { AND: and } : {};
  const [total, items] = await Promise.all([
    prisma.redirect.count({ where }),
    prisma.redirect.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

async function activeMap(excludeId?: string) {
  const rows = await prisma.redirect.findMany({ where: { isActive: true, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { fromPath: true, toPath: true } });
  return new Map(rows.map((r) => [r.fromPath, r.toPath]));
}

export type RedirectInput = { fromPath: string; toPath: string; statusCode: 301 | 302; isActive: boolean };

/** Loop check runs against ACTIVE rules only (an inactive rule cannot loop), excluding the row being edited. */
async function assertNoLoop(input: RedirectInput, excludeId?: string) {
  if (!input.isActive) return;
  const loop = detectRedirectLoop(input.fromPath, input.toPath, await activeMap(excludeId));
  if (!loop.ok) throw new UserFacingError(loop.error);
}

export async function adminCreateRedirect(input: RedirectInput) {
  await assertNoLoop(input);
  try {
    return await prisma.redirect.create({ data: input });
  } catch (e) {
    if (isUnique(e)) throw new UserFacingError("A redirect from that path already exists. Edit it instead.");
    throw e;
  }
}

export async function adminUpdateRedirect(id: string, input: RedirectInput) {
  await assertNoLoop(input, id);
  try {
    return await prisma.redirect.update({ where: { id }, data: input });
  } catch (e) {
    if (isUnique(e)) throw new UserFacingError("A redirect from that path already exists.");
    if (isMissing(e)) throw new UserFacingError("That redirect no longer exists.");
    throw e;
  }
}

export async function adminDeleteRedirect(id: string) {
  try {
    await prisma.redirect.delete({ where: { id } });
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
}
