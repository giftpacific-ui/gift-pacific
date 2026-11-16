"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { sanitizeProductHtml } from "@/lib/sanitize-html";
import { SYSTEM_PAGE_KEYS, systemPageByKey } from "@/lib/seo-pages";
import { buildRobotsTxtRules } from "@/lib/seo-rules";
import {
  validateGlobalSeo, validatePageSeo, validateEntitySeo, validateStaticPage, validateRedirect,
} from "@/lib/seo-validate";
import { prisma } from "@/lib/db/prisma";
import { getCanonicalOrigin } from "@/server/services/seo.service";
import { updateEntitySeo, type EntityKind } from "@/server/services/admin-seo.service";
import {
  adminUpsertPageSeo, adminCreateStaticPage, adminUpdateStaticPage, adminDeleteStaticPage, adminGetStaticPage,
  adminCreateRedirect, adminUpdateRedirect, adminDeleteRedirect,
} from "@/server/services/admin-cms.service";
import { clearRedirectCache } from "@/server/services/redirect.service";

/**
 * Every exported action authorizes with requireAdmin() FIRST, validates the payload server-side (lib/seo-validate.ts), writes through
 * the service layer and then invalidates the public cache. The browser's values are never trusted.
 */

export type SeoActionResult = { success: true; id?: string; warnings?: string[] } | { success: false; message: string };

const fail = (message: string): SeoActionResult => ({ success: false, message });

/** SEO changes can affect every public page (metadata, robots, sitemap), so the whole public layout is revalidated. */
function revalidatePublic() {
  revalidatePath("/", "layout");
  revalidatePath("/sitemap.xml");
  revalidatePath("/robots.txt");
}

export async function saveGlobalSeoAction(raw: Record<string, unknown>): Promise<SeoActionResult> {
  await requireAdmin();
  const v = validateGlobalSeo(raw);
  if (!v.ok) return fail(v.error);
  try {
    await prisma.storeSettings.upsert({ where: { id: "singleton" }, update: v.value, create: { id: "singleton", ...v.value } });
    revalidatePublic();
    // Tell the admin about robots.txt lines that were NOT applied rather than dropping them silently.
    const { rejected } = buildRobotsTxtRules(v.value.seoRobotsExtra);
    return { success: true, warnings: rejected.map((r) => `robots.txt: "${r.line}" ignored — ${r.reason}`) };
  } catch (e) {
    return fail(toUserMessage(e, "Could not save the SEO settings."));
  }
}

export async function savePageSeoAction(key: string, raw: Record<string, unknown>): Promise<SeoActionResult> {
  await requireAdmin();
  if (!SYSTEM_PAGE_KEYS.has(key)) return fail("Unknown page.");
  const v = validatePageSeo(raw, await getCanonicalOrigin());
  if (!v.ok) return fail(v.error);
  try {
    await adminUpsertPageSeo(key, v.value);
    revalidatePublic();
    return { success: true };
  } catch (e) {
    return fail(toUserMessage(e, "Could not save the page SEO."));
  }
}

export async function saveEntitySeoAction(kind: EntityKind, id: string, raw: Record<string, unknown>): Promise<SeoActionResult> {
  await requireAdmin();
  if (kind !== "product" && kind !== "category" && kind !== "box") return fail("Unknown record type.");
  if (typeof id !== "string" || !id) return fail("Missing record.");
  const v = validateEntitySeo(raw, await getCanonicalOrigin());
  if (!v.ok) return fail(v.error);
  try {
    await updateEntitySeo(kind, id, v.value);
    revalidatePublic();
    return { success: true };
  } catch (e) {
    return fail(toUserMessage(e, "Could not save the SEO fields."));
  }
}

/** Create or update a CMS page. `raw.id` updates; `raw.systemKey` (about-us, privacy, terms, shipping-returns) creates the override for a built-in route. */
export async function saveStaticPageAction(raw: Record<string, unknown>): Promise<SeoActionResult> {
  await requireAdmin();
  const origin = await getCanonicalOrigin();
  try {
    const id = typeof raw.id === "string" && raw.id ? raw.id : null;
    if (id) {
      const existing = await adminGetStaticPage(id);
      if (!existing) return fail("That page no longer exists.");
      const v = validateStaticPage(raw, origin, sanitizeProductHtml, existing.systemKey ? { slug: existing.slug } : undefined);
      if (!v.ok) return fail(v.error);
      await adminUpdateStaticPage(id, v.value);
      revalidatePublic();
      return { success: true, id };
    }
    const systemKey = typeof raw.systemKey === "string" && raw.systemKey ? raw.systemKey : undefined;
    const sys = systemKey ? systemPageByKey(systemKey) : undefined;
    if (systemKey && !sys?.cms) return fail("That built-in page cannot be replaced.");
    const v = validateStaticPage(raw, origin, sanitizeProductHtml, sys ? { slug: sys.key } : undefined);
    if (!v.ok) return fail(v.error);
    const created = await adminCreateStaticPage(v.value, systemKey);
    revalidatePublic();
    return { success: true, id: created.id };
  } catch (e) {
    return fail(toUserMessage(e, "Could not save the page."));
  }
}

export async function deleteStaticPageAction(id: string): Promise<SeoActionResult> {
  await requireAdmin();
  try {
    await adminDeleteStaticPage(id);
    revalidatePublic();
    return { success: true };
  } catch (e) {
    return fail(toUserMessage(e, "Could not delete the page."));
  }
}

export async function saveRedirectAction(raw: Record<string, unknown>): Promise<SeoActionResult> {
  await requireAdmin();
  const v = validateRedirect(raw, await getCanonicalOrigin());
  if (!v.ok) return fail(v.error);
  try {
    const id = typeof raw.id === "string" && raw.id ? raw.id : null;
    const row = id ? await adminUpdateRedirect(id, v.value) : await adminCreateRedirect(v.value);
    clearRedirectCache();
    return { success: true, id: row.id };
  } catch (e) {
    return fail(toUserMessage(e, "Could not save the redirect."));
  }
}

export async function deleteRedirectAction(id: string): Promise<SeoActionResult> {
  await requireAdmin();
  try {
    await adminDeleteRedirect(id);
    clearRedirectCache();
    return { success: true };
  } catch (e) {
    return fail(toUserMessage(e, "Could not delete the redirect."));
  }
}
