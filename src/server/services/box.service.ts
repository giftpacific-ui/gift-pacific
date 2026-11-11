import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { boxSchema, type BoxInput } from "@/lib/validations/box";
import { applyStockDelta } from "@/server/services/stock-adjustment.service";
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** The ONLY fields the public site receives (allow-list). Inactive boxes are never selected. */
export type PublicBox = {
  id: string; name: string; slug: string; description: string | null; imageUrl: string | null;
  price: number; productSlug: string | null; productId: string | null; inStock: boolean; seoTitle: string | null; seoDescription: string | null; seoKeywords: string[];
};

const publicSelect = {
  id: true, name: true, slug: true, description: true, imageUrl: true, price: true,
  seoTitle: true, seoDescription: true, seoKeywords: true,
  product: { select: { id: true, slug: true, status: true, stock: true, allowBackorder: true, trackInventory: true } },
} as const;

type Row = {
  id: string; name: string; slug: string; description: string | null; imageUrl: string | null; price: unknown;
  seoTitle: string | null; seoDescription: string | null; seoKeywords: string[];
  product: { id: string; slug: string; status: string; stock: number; allowBackorder: boolean; trackInventory: boolean } | null;
};
const toPublic = (b: Row): PublicBox => ({
  id: b.id, name: b.name, slug: b.slug, description: b.description, imageUrl: b.imageUrl, price: Number(b.price),
  // A box is purchasable only through a linked, ACTIVE product (that product enforces price, stock and checkout rules).
  productSlug: b.product && b.product.status === "ACTIVE" ? b.product.slug : null,
  productId: b.product && b.product.status === "ACTIVE" ? b.product.id : null,
  inStock: Boolean(b.product && b.product.status === "ACTIVE" && (!b.product.trackInventory || b.product.stock > 0 || b.product.allowBackorder)),
  seoTitle: b.seoTitle, seoDescription: b.seoDescription, seoKeywords: b.seoKeywords ?? [],
});

export async function getActiveBoxes(): Promise<PublicBox[]> {
  const rows = await prisma.box.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: publicSelect });
  return rows.map(toPublic);
}

export async function getActiveBoxBySlug(slug: string): Promise<PublicBox | null> {
  const row = await prisma.box.findFirst({ where: { slug, isActive: true }, select: publicSelect });
  return row ? toPublic(row) : null;
}

export async function adminListBoxes() {
  return prisma.box.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], include: { product: { select: { isBoxProduct: true, stock: true, allowBackorder: true } } } });
}

/** Products that can still be linked (not already linked to another box). */
export async function adminLinkableProducts(currentBoxId: string | null) {
  const taken = await prisma.box.findMany({ where: { productId: { not: null }, ...(currentBoxId ? { id: { not: currentBoxId } } : {}) }, select: { productId: true } });
  return prisma.product.findMany({
    where: { kind: "SINGLE", id: { notIn: taken.map((t) => t.productId!).filter(Boolean) } },
    orderBy: { name: "asc" }, select: { id: true, name: true, status: true }, take: 500,
  });
}

/** Is this Cloudinary asset still referenced by any box (other than `exceptBoxId`)? */
async function stillReferenced(publicId: string, exceptBoxId: string | null) {
  return (await prisma.box.count({ where: { imagePublicId: publicId, ...(exceptBoxId ? { id: { not: exceptBoxId } } : {}) } })) > 0;
}

/**
 * Saves a box AND its hidden managed product in one transaction, so box-specific price, stock and
 * backorder policy live on the Box screen while cart, checkout, stock deduction/restoration, cancellation,
 * invoices and snapshots keep using the single existing product implementation. Boxes created before this
 * change that are linked to an ordinary product keep that link untouched (legacy), with their price/stock
 * managed on that product.
 * Returns the Cloudinary public id that is now orphaned (caller deletes it AFTER the save), or null.
 */
export async function adminSaveBox(id: string | null, raw: BoxInput): Promise<{ id: string; orphanedPublicId: string | null }> {
  const parsed = boxSchema.safeParse(raw);
  if (!parsed.success) throw new UserFacingError(parsed.error.issues[0]?.message ?? "Please check the form.");
  const { stock, allowBackorder, ...box } = parsed.data;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const before = id
        ? await tx.box.findUnique({ where: { id }, select: { imagePublicId: true, productId: true, product: { select: { id: true, isBoxProduct: true, stock: true } } } })
        : null;
      if (id && !before) throw new UserFacingError("Box not found.");

      let productId = before?.productId ?? null;
      const status = box.isActive ? "ACTIVE" : "DRAFT";
      const productFields = { name: box.name, description: box.description || box.name, price: box.price, status, allowBackorder, trackInventory: true } as const;
      if (!productId) {
        let slug = `box-${box.slug}`.slice(0, 90);
        for (let i = 2; await tx.product.findUnique({ where: { slug }, select: { id: true } }); i++) slug = `box-${box.slug}-${i}`.slice(0, 90);
        const created = await tx.product.create({ data: { ...productFields, slug, type: "STANDARD", kind: "SINGLE", stock: 0, isBoxProduct: true }, select: { id: true } });
        productId = created.id;
        if (stock > 0) await applyStockDelta(tx, { productId, variantId: null, delta: stock, reason: "Box created", adminId: null });
        if (box.imageUrl) await tx.productImage.create({ data: { productId, url: box.imageUrl, cloudinaryPublicId: box.imagePublicId, altText: box.name, isMain: true, sortOrder: 0 } });
      } else if (before?.product?.isBoxProduct) {
        await tx.product.update({ where: { id: productId }, data: productFields });
        const delta = stock - before.product.stock;
        if (delta !== 0) await applyStockDelta(tx, { productId, variantId: null, delta, reason: "Box edited", adminId: null });
        await tx.productImage.deleteMany({ where: { productId } });
        if (box.imageUrl) await tx.productImage.create({ data: { productId, url: box.imageUrl, cloudinaryPublicId: box.imagePublicId, altText: box.name, isMain: true, sortOrder: 0 } });
      }

      const data = { ...box, productId };
      let boxId: string;
      if (!id) boxId = (await tx.box.create({ data, select: { id: true } })).id;
      else { await tx.box.update({ where: { id }, data }); boxId = id; }
      const old = before?.imagePublicId ?? null;
      return { boxId, old };
    });
    const orphan = result.old && result.old !== box.imagePublicId && !(await stillReferenced(result.old, result.boxId)) ? result.old : null;
    return { id: result.boxId, orphanedPublicId: orphan };
  } catch (error) {
    if (isUniqueViolation(error)) throw new UserFacingError("That URL slug is already used by another box.");
    throw error;
  }
}

export async function adminDeleteBox(id: string): Promise<string | null> {
  const box = await prisma.box.findUnique({ where: { id }, select: { imagePublicId: true, productId: true, product: { select: { isBoxProduct: true } } } });
  if (!box) throw new UserFacingError("Box not found.");
  await prisma.$transaction(async (tx) => {
    await tx.box.delete({ where: { id } });
    // Past orders reference the managed product, so it is archived (hidden, unsellable), never deleted.
    if (box.productId && box.product?.isBoxProduct) await tx.product.update({ where: { id: box.productId }, data: { status: "ARCHIVED" } });
  });
  return box.imagePublicId && !(await stillReferenced(box.imagePublicId, id)) ? box.imagePublicId : null;
}

/** Moves a box one position up/down by swapping sortOrder with its neighbour (list is renumbered first so ties can't stall). */
export async function adminMoveBox(id: string, direction: "up" | "down") {
  await prisma.$transaction(async (tx) => {
    const all = await tx.box.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } });
    const i = all.findIndex((b) => b.id === id);
    if (i < 0) throw new UserFacingError("Box not found.");
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    for (let k = 0; k < all.length; k++) await tx.box.update({ where: { id: all[k].id }, data: { sortOrder: k } });
  });
}

export async function adminToggleBox(id: string, isActive: boolean) {
  const box = await prisma.box.findUnique({ where: { id }, select: { productId: true, product: { select: { isBoxProduct: true } } } });
  if (!box) throw new UserFacingError("Box not found.");
  await prisma.$transaction(async (tx) => {
    await tx.box.update({ where: { id }, data: { isActive } });
    if (box.productId && box.product?.isBoxProduct) await tx.product.update({ where: { id: box.productId }, data: { status: isActive ? "ACTIVE" : "DRAFT" } });
  });
}
