import "server-only";
import type { Prisma, Product, ProductVariant } from "@prisma/client";
import {
  componentDemand,
  demandKey,
  maxComboUnits,
  resolveCombo,
  type ComboProduct,
  type ComboResolution,
  type ComboTemplate,
} from "@/lib/combo";
import { MAX_QUANTITY_PER_LINE, maxOrderableQuantity, resolveLineStock, type Availability } from "@/lib/stock";
import { prisma } from "@/lib/db/prisma";
import type { PublicComboBuilder } from "@/lib/product-dto";
import { UserFacingError } from "@/lib/errors";

type Db = Prisma.TransactionClient;

type ProductWithVariants = Product & { variants: ProductVariant[] };

export function toComboProduct(p: ProductWithVariants): ComboProduct {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    kind: p.kind,
    status: p.status,
    price: Number(p.price),
    costPrice: p.costPrice === null ? null : Number(p.costPrice),
    trackInventory: p.trackInventory,
    allowBackorder: p.allowBackorder,
    stock: p.stock,
    variants: p.variants.map((v) => ({
      id: v.id,
      name: v.name,
      price: Number(v.price),
      stock: v.stock,
      allowBackorder: v.allowBackorder,
    })),
  };
}

/** Loads the live template of each combo product id (combos only; singles are skipped). */
/** Upper bound on synthesized choices per slot (keeps the builder and the query bounded). */
export const MAX_DYNAMIC_OPTIONS = 500;
export const catalogOptionId = (productId: string, variantId: string | null) => (variantId ? `c:${productId}:${variantId}` : `c:${productId}`);
export const boxOptionId = (boxId: string) => `b:${boxId}`;

/**
 * Choices for CATALOG / BOXES slots, rebuilt from live data on every read, so the server always decides
 * eligibility: only ACTIVE single products (never combos) and only boxes that are active AND linked to an
 * ACTIVE product can be chosen. Option ids are deterministic ("c:<product>[:<variant>]", "b:<box>") so
 * carts and order snapshots stay valid; they are plain strings (no foreign key) and are re-checked on every pricing pass.
 */
async function buildDynamicOptions(db: Db, source: "CATALOG" | "BOXES", categoryId: string | null): Promise<ComboTemplate["slots"][number]["options"]> {
  if (source === "BOXES") {
    const boxes = await db.box.findMany({
      where: { isActive: true, productId: { not: null } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: MAX_DYNAMIC_OPTIONS,
      include: { product: { include: { variants: true } } },
    });
    return boxes
      .filter((b) => b.product && b.product.status === "ACTIVE" && b.product.kind === "SINGLE" && b.product.type !== "VARIANT")
      .map((b) => ({ id: boxOptionId(b.id), productId: b.product!.id, variantId: null, priceDelta: Number(b.price), product: toComboProduct(b.product!) }));
  }
  const products = await db.product.findMany({
    where: { status: "ACTIVE", kind: "SINGLE", isBoxProduct: false, ...(categoryId ? { categoryId } : {}) },
    orderBy: { name: "asc" },
    take: MAX_DYNAMIC_OPTIONS,
    include: { variants: true },
  });
  const out: ComboTemplate["slots"][number]["options"] = [];
  for (const p of products) {
    const cp = toComboProduct(p);
    if (p.type === "VARIANT") {
      for (const v of p.variants) out.push({ id: catalogOptionId(p.id, v.id), productId: p.id, variantId: v.id, priceDelta: 0, product: cp });
    } else out.push({ id: catalogOptionId(p.id, null), productId: p.id, variantId: null, priceDelta: 0, product: cp });
  }
  return out.slice(0, MAX_DYNAMIC_OPTIONS);
}

export async function loadComboTemplates(db: Db, comboIds: string[]): Promise<Map<string, ComboTemplate>> {
  const templates = new Map<string, ComboTemplate>();
  if (comboIds.length === 0) return templates;
  const rows = await db.product.findMany({
    where: { id: { in: [...new Set(comboIds)] }, kind: "COMBO" },
    include: {
      bundleItems: { orderBy: { id: "asc" }, include: { component: { include: { variants: true } } } },
      comboSlots: {
        orderBy: { sortOrder: "asc" },
        include: {
          options: { orderBy: { sortOrder: "asc" }, include: { product: { include: { variants: true } } } },
        },
      },
    },
  });
  const dynamicOptions = new Map<string, ComboTemplate["slots"][number]["options"]>();
  for (const row of rows) {
    for (const s of row.comboSlots) {
      if (s.source !== "MANUAL") dynamicOptions.set(s.id, await buildDynamicOptions(db, s.source, s.categoryId));
    }
  }
  for (const row of rows) {
    if (!row.comboMode || !row.comboPricing || !row.comboStockPolicy) continue;
    templates.set(row.id, {
      id: row.id,
      mode: row.comboMode,
      pricing: row.comboPricing,
      stockPolicy: row.comboStockPolicy,
      basePrice: Number(row.price),
      fixedComponents: row.bundleItems.map((b) => ({
        productId: b.componentId,
        variantId: b.variantId,
        quantity: b.quantity,
        product: toComboProduct(b.component),
      })),
      slots: row.comboSlots.map((s) => ({
        id: s.id,
                label: s.label,
        helpText: s.helpText,
        minSelect: s.minSelect,
        maxSelect: s.maxSelect,
        maxPerOption: s.maxPerOption,
        options: s.source !== "MANUAL"
          ? dynamicOptions.get(s.id) ?? []
          : s.options.map((o) => ({
              id: o.id,
              productId: o.productId,
              variantId: o.variantId,
              priceDelta: Number(o.priceDelta),
              product: toComboProduct(o.product),
            })),
      })),
    });
  }
  return templates;
}

/** A cart line as loaded by the cart/checkout queries. */
export type CartLineInput = {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  product: ProductWithVariants;
  variant: ProductVariant | null;
  selections: { slotId: string; optionId: string; quantity: number }[];
};

export type LineDemand = {
  productId: string;
  variantId: string | null;
  /** Units consumed per ONE unit of the line. */
  perUnit: number;
  stock: number;
  trackInventory: boolean;
  allowBackorder: boolean;
  name: string;
};

export type ResolvedLine = {
  lineId: string;
  /** Price of ONE unit, decided on the server. */
  unitPrice: number;
  /** Why this line cannot be bought right now (null = purchasable). */
  unavailableReason: string | null;
  combo: { template: ComboTemplate; resolution: ComboResolution } | null;
  /** Stock-consuming demand of one unit. Empty for untracked lines. */
  demand: LineDemand[];
  /** Largest quantity this line alone could ever take (null = unlimited), capped per line. */
  maxQuantity: number | null;
};

function singleDemand(line: CartLineInput): LineDemand[] {
  const fields = resolveLineStock({ trackInventory: line.product.trackInventory, product: line.product, variant: line.variant });
  if (!fields.trackInventory) return [];
  return [
    {
      productId: line.productId,
      variantId: line.variant?.id ?? null,
      perUnit: 1,
      stock: fields.stock,
      trackInventory: true,
      allowBackorder: fields.allowBackorder,
      name: line.product.name,
    },
  ];
}

/**
 * Resolves every cart line to a server-decided price, availability and stock demand.
 * Combos are re-validated here from the stored selection, so a template edited after the
 * item was added (a component deactivated, a price changed) is always reflected.
 */
export async function resolveCartLines(db: Db, lines: CartLineInput[]): Promise<ResolvedLine[]> {
  const comboIds = lines.filter((l) => l.product.kind === "COMBO").map((l) => l.productId);
  const templates = await loadComboTemplates(db, comboIds);
  return lines.map((line): ResolvedLine => {
    if (line.product.kind !== "COMBO") {
      if (line.product.type === "VARIANT" && !line.variant) {
        return { lineId: line.id, unitPrice: Number(line.product.price), unavailableReason: "This option is no longer available.", combo: null, demand: [], maxQuantity: 0 };
      }
      const demand = singleDemand(line);
      const fields = resolveLineStock({ trackInventory: line.product.trackInventory, product: line.product, variant: line.variant });
      const orderable = maxOrderableQuantity(fields);
      const max = Number.isFinite(orderable) ? Math.min(orderable, MAX_QUANTITY_PER_LINE) : null;
      return {
        lineId: line.id,
        unitPrice: Number(line.variant ? line.variant.price : line.product.price),
        unavailableReason: max === 0 ? "Out of stock" : null,
        combo: null,
        demand,
        maxQuantity: max,
      };
    }

    const template = templates.get(line.productId);
    if (!template) {
      return { lineId: line.id, unitPrice: Number(line.product.price), unavailableReason: "This combo is no longer available.", combo: null, demand: [], maxQuantity: 0 };
    }
    if (line.product.status !== "ACTIVE") {
      return { lineId: line.id, unitPrice: Number(line.product.price), unavailableReason: "This combo is no longer available.", combo: null, demand: [], maxQuantity: 0 };
    }
    const result = resolveCombo(template, template.mode === "CUSTOMIZABLE" ? line.selections : undefined);
    if (!result.ok) {
      return { lineId: line.id, unitPrice: Number(line.product.price), unavailableReason: result.message, combo: null, demand: [], maxQuantity: 0 };
    }
    const resolution = result.value;

    if (template.stockPolicy === "OWN_STOCK") {
      // The finished box is counted; components are descriptive only.
      const demand = singleDemand({ ...line, variant: null });
      const fields = resolveLineStock({ trackInventory: line.product.trackInventory, product: line.product, variant: null });
      const orderable = maxOrderableQuantity(fields);
      const max = Number.isFinite(orderable) ? Math.min(orderable, MAX_QUANTITY_PER_LINE) : null;
      return {
        lineId: line.id,
        unitPrice: resolution.unitPrice,
        unavailableReason: max === 0 ? "Out of stock" : null,
        combo: { template, resolution },
        demand,
        maxQuantity: max,
      };
    }

    // COMPONENTS: every tracked component's stock is consumed.
    const demand: LineDemand[] = resolution.components
      .filter((c) => c.trackInventory)
      .map((c) => ({
        productId: c.productId,
        variantId: c.variantId,
        perUnit: c.quantity,
        stock: c.stock,
        trackInventory: true,
        allowBackorder: c.allowBackorder,
        name: c.productName,
      }));
    const units = maxComboUnits(resolution.components);
    const max = Number.isFinite(units) ? Math.min(units, MAX_QUANTITY_PER_LINE) : null;
    return {
      lineId: line.id,
      unitPrice: resolution.unitPrice,
      unavailableReason: max === 0 ? "Out of stock" : null,
      combo: { template, resolution },
      demand,
      maxQuantity: max,
    };
  });
}

/**
 * Checks the WHOLE cart's stock demand at once, keyed by (product, variant): a component
 * that appears in two combos — or also as a single product — is compared with its real
 * stock exactly once. Throws a customer-readable error for the first shortfall.
 */
export function assertDemandFits(lines: { quantity: number; resolved: ResolvedLine }[]): void {
  const totals = new Map<string, { needed: number; entry: LineDemand }>();
  for (const { quantity, resolved } of lines) {
    for (const d of resolved.demand) {
      const key = demandKey(d);
      const cur = totals.get(key);
      const needed = d.perUnit * quantity;
      if (cur) cur.needed += needed;
      else totals.set(key, { needed, entry: d });
    }
  }
  for (const { needed, entry } of totals.values()) {
    if (entry.allowBackorder || !entry.trackInventory) continue;
    if (needed > Math.max(entry.stock, 0)) {
      throw new UserFacingError(
        entry.stock <= 0 ? `"${entry.name}" is out of stock.` : `Only ${entry.stock} of "${entry.name}" left in stock.`,
      );
    }
  }
}

export { componentDemand };

/**
 * Public view of a combo that draws on component stock: real availability and, for a
 * customizable combo, the builder payload. Display data only — selections are always
 * re-validated by resolveCombo() on the server.
 */
export async function getComboPublicView(
  comboId: string,
): Promise<{ availability: Availability | null; builder: PublicComboBuilder | null }> {
  const template = (await loadComboTemplates(prisma, [comboId])).get(comboId);
  if (!template || template.stockPolicy === "OWN_STOCK") return { availability: null, builder: null };

  if (template.mode === "FIXED") {
    const resolved = resolveCombo(template, undefined);
    if (!resolved.ok) return { availability: { inStock: false, maxQuantity: 0 }, builder: null };
    const units = maxComboUnits(resolved.value.components);
    return {
      availability: { inStock: units > 0, maxQuantity: Number.isFinite(units) ? Math.min(units, MAX_QUANTITY_PER_LINE) : null },
      builder: null,
    };
  }

  const productIds = [...new Set(template.slots.flatMap((s) => s.options.map((o) => o.productId)))];
  const images = productIds.length
    ? await prisma.productImage.findMany({ where: { productId: { in: productIds } }, orderBy: { sortOrder: "asc" }, select: { productId: true, url: true } })
    : [];
  const imageOf = new Map<string, string>();
  for (const img of images) if (!imageOf.has(img.productId)) imageOf.set(img.productId, img.url);

  let buildable = true;
  const slots = template.slots.map((slot) => {
    const options = slot.options.map((o) => {
      const variant = o.variantId ? o.product.variants.find((v) => v.id === o.variantId) ?? null : null;
      const needsVariant = o.product.type === "VARIANT";
      const stock = variant ? variant.stock : o.product.stock;
      const allowBackorder = variant ? variant.allowBackorder : o.product.allowBackorder;
      const limited = o.product.trackInventory && !allowBackorder;
      const available = o.product.status === "ACTIVE" && o.product.kind === "SINGLE" && (!needsVariant || variant !== null) && (!limited || stock >= 1);
      return {
        id: o.id,
        name: o.product.name,
        variantName: variant?.name ?? null,
        image: imageOf.get(o.productId) ?? null,
        price: variant ? variant.price : o.product.price,
        priceDelta: o.priceDelta,
        available,
        maxQuantity: limited ? Math.min(slot.maxPerOption, Math.max(0, stock)) : slot.maxPerOption,
      };
    });
    const capacity = Math.min(slot.maxSelect, options.filter((o) => o.available).reduce((sum, o) => sum + (o.maxQuantity ?? slot.maxPerOption), 0));
    if (capacity < slot.minSelect) buildable = false;
    return { id: slot.id, label: slot.label, helpText: slot.helpText ?? null, minSelect: slot.minSelect, maxSelect: slot.maxSelect, maxPerOption: slot.maxPerOption, options };
  });
  if (slots.length === 0) buildable = false;
  return {
    availability: { inStock: buildable, maxQuantity: buildable ? null : 0 },
    builder: { pricing: template.pricing, basePrice: template.basePrice, slots },
  };
}
