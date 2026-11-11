import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import {
  buildAttributeWhere,
  parseAttributeFilters,
  slugifyKey,
  validateAttributeDefinition,
  validateAttributeValue,
  type AttributeDef,
  type AttributeValueType,
  type StoredValue,
} from "@/lib/attributes";
import type { Prisma } from "@prisma/client";

type AttrRow = Prisma.AttributeGetPayload<{ include: { options: true } }>;

export type AttributeDefFull = AttributeDef & {
  groupId: string;
  isFilterable: boolean;
  showOnProduct: boolean;
  isActive: boolean;
  sortOrder: number;
};

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

function toDef(a: AttrRow): AttributeDefFull {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    groupId: a.groupId,
    valueType: a.valueType,
    unit: a.unit,
    minNumber: num(a.minNumber),
    maxNumber: num(a.maxNumber),
    maxLength: a.maxLength,
    isRequired: a.isRequired,
    isFilterable: a.isFilterable,
    showOnProduct: a.showOnProduct,
    isActive: a.isActive,
    sortOrder: a.sortOrder,
    options: [...a.options].sort((x, y) => x.sortOrder - y.sortOrder).map((o) => ({ id: o.id, value: o.value, label: o.label })),
  };
}

// ---------------------------------------------------------------------------
// ADMIN — groups, attributes, options (call only after requireAdmin())
// ---------------------------------------------------------------------------
export async function adminListAttributeGroups() {
  const groups = await prisma.attributeGroup.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { attributes: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }], include: { options: true } } },
  });
  const usage = await prisma.productAttributeValue.groupBy({ by: ["attributeId"], _count: { _all: true } }).catch(() => []);
  const optionUsage = await prisma.productAttributeOption.groupBy({ by: ["attributeId"], _count: { _all: true } }).catch(() => []);
  const used = new Map<string, number>();
  for (const u of [...usage, ...optionUsage]) used.set(u.attributeId, (used.get(u.attributeId) ?? 0) + u._count._all);
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    slug: g.slug,
    sortOrder: g.sortOrder,
    isActive: g.isActive,
    attributes: g.attributes.map((a) => ({ ...toDef(a), productCount: used.get(a.id) ?? 0 })),
  }));
}

export async function adminSaveGroup(id: string | null, input: { name: string; sortOrder?: number; isActive?: boolean }) {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new UserFacingError("Group name is required (max 80 characters).");
  const data = { name, sortOrder: input.sortOrder ?? 0, isActive: input.isActive ?? true };
  if (id) {
    const r = await prisma.attributeGroup.updateMany({ where: { id }, data });
    if (r.count !== 1) throw new UserFacingError("Group not found.");
    return;
  }
  const base = slugifyKey(name) || "group";
  let slug = base;
  for (let i = 2; await prisma.attributeGroup.findUnique({ where: { slug }, select: { id: true } }); i++) slug = `${base}-${i}`;
  await prisma.attributeGroup.create({ data: { ...data, slug } });
}

export async function adminDeleteGroup(id: string) {
  const count = await prisma.attribute.count({ where: { groupId: id } });
  if (count > 0) throw new UserFacingError("Remove or move this group's attributes first.");
  await prisma.attributeGroup.deleteMany({ where: { id } });
}

export type AttributeInput = {
  groupId: string;
  name: string;
  valueType: AttributeValueType;
  unit?: string | null;
  minNumber?: number | null;
  maxNumber?: number | null;
  maxLength?: number | null;
  isRequired?: boolean;
  isFilterable?: boolean;
  showOnProduct?: boolean;
  sortOrder?: number;
  isActive?: boolean;
};

export async function adminSaveAttribute(id: string | null, input: AttributeInput) {
  const error = validateAttributeDefinition(input);
  if (error) throw new UserFacingError(error);
  if (!(await prisma.attributeGroup.findUnique({ where: { id: input.groupId }, select: { id: true } }))) {
    throw new UserFacingError("Choose a group for this attribute.");
  }
  const data = {
    groupId: input.groupId,
    name: input.name.trim(),
    valueType: input.valueType,
    unit: input.unit?.trim() || null,
    minNumber: input.minNumber ?? null,
    maxNumber: input.maxNumber ?? null,
    maxLength: input.maxLength ?? null,
    isRequired: input.isRequired ?? false,
    isFilterable: input.isFilterable ?? false,
    showOnProduct: input.showOnProduct ?? true,
    sortOrder: input.sortOrder ?? 0,
    isActive: input.isActive ?? true,
  };
  if (id) {
    const current = await prisma.attribute.findUnique({ where: { id }, select: { valueType: true } });
    if (!current) throw new UserFacingError("Attribute not found.");
    if (current.valueType !== input.valueType) {
      // Changing the type of an attribute that already has values would corrupt them.
      const inUse =
        (await prisma.productAttributeValue.count({ where: { attributeId: id } })) +
        (await prisma.productAttributeOption.count({ where: { attributeId: id } }));
      if (inUse > 0) throw new UserFacingError("This attribute is already used by products, so its type cannot change.");
    }
    await prisma.attribute.update({ where: { id }, data });
    return;
  }
  const base = slugifyKey(input.name) || "attribute";
  let slug = base;
  for (let i = 2; await prisma.attribute.findUnique({ where: { slug }, select: { id: true } }); i++) slug = `${base}-${i}`;
  await prisma.attribute.create({ data: { ...data, slug } });
}

export async function adminDeleteAttribute(id: string) {
  await prisma.attribute.deleteMany({ where: { id } }); // product values/options cascade
}

export async function adminSaveOption(attributeId: string, optionId: string | null, input: { label: string; sortOrder?: number }) {
  const attribute = await prisma.attribute.findUnique({ where: { id: attributeId }, select: { valueType: true } });
  if (!attribute) throw new UserFacingError("Attribute not found.");
  if (attribute.valueType !== "SELECT" && attribute.valueType !== "MULTI_SELECT") {
    throw new UserFacingError("Only choice attributes have options.");
  }
  const label = input.label.trim();
  if (!label || label.length > 80) throw new UserFacingError("Option name is required (max 80 characters).");
  const value = slugifyKey(label);
  if (!value) throw new UserFacingError("Option name must contain letters or numbers.");
  const clash = await prisma.attributeOption.findFirst({ where: { attributeId, value, ...(optionId ? { id: { not: optionId } } : {}) } });
  if (clash) throw new UserFacingError("That option already exists.");
  if (optionId) {
    const r = await prisma.attributeOption.updateMany({ where: { id: optionId, attributeId }, data: { label, value, sortOrder: input.sortOrder ?? 0 } });
    if (r.count !== 1) throw new UserFacingError("Option not found.");
  } else {
    await prisma.attributeOption.create({ data: { attributeId, label, value, sortOrder: input.sortOrder ?? (await prisma.attributeOption.count({ where: { attributeId } })) } });
  }
}

export async function adminDeleteOption(attributeId: string, optionId: string) {
  const used = await prisma.productAttributeOption.count({ where: { optionId } });
  if (used > 0) throw new UserFacingError(`${used} product(s) use this option. Change those products first.`);
  await prisma.attributeOption.deleteMany({ where: { id: optionId, attributeId } });
}

// ---------------------------------------------------------------------------
// PRODUCT VALUES
// ---------------------------------------------------------------------------
export type ProductAttributeEntry = { attributeId: string; value: unknown };

/** Active attribute definitions only (for the create flow, where no product exists yet). */
export async function adminListAttributeDefs() {
  const [attrs, groups] = await Promise.all([
    prisma.attribute.findMany({ where: { isActive: true }, include: { options: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.attributeGroup.findMany({ select: { id: true, name: true } }),
  ]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  return attrs.map((a) => ({ ...toDef(a), groupName: groupName.get(a.groupId) ?? "" }));
}

/** Active attribute definitions, and the values currently stored for the product. */
export async function adminGetProductAttributeData(productId: string) {
  const [attrs, groups, values, links] = await Promise.all([
    prisma.attribute.findMany({ where: { isActive: true }, include: { options: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.attributeGroup.findMany({ select: { id: true, name: true } }),
    prisma.productAttributeValue.findMany({ where: { productId } }),
    prisma.productAttributeOption.findMany({ where: { productId } }),
  ]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const defs = attrs.map((a) => ({ ...toDef(a), groupName: groupName.get(a.groupId) ?? "" }));
  const current: Record<string, unknown> = {};
  for (const v of values) current[v.attributeId] = v.valueText ?? (v.valueNumber !== null ? Number(v.valueNumber) : v.valueBoolean);
  for (const l of links) {
    const def = attrs.find((a) => a.id === l.attributeId);
    if (def?.valueType === "MULTI_SELECT") ((current[l.attributeId] as string[] | undefined) ??= []).push(l.optionId);
    else current[l.attributeId] = l.optionId;
  }
  return { defs, current };
}

/**
 * Replaces the product's attribute values. Only attributes present in `entries` are assigned;
 * every value is validated against its definition on the server. Required attributes must be
 * filled whenever they are assigned.
 */
export async function adminSaveProductAttributes(productId: string, entries: ProductAttributeEntry[]) {
  if (!Array.isArray(entries) || entries.length > 200) throw new UserFacingError("Invalid attributes.");
  const ids = entries.map((e) => String(e.attributeId));
  if (new Set(ids).size !== ids.length) throw new UserFacingError("An attribute was listed twice.");
  const attrs = await prisma.attribute.findMany({ where: { id: { in: ids }, isActive: true }, include: { options: true } });
  const toStore: { attributeId: string; stored: StoredValue }[] = [];
  for (const entry of entries) {
    const attr = attrs.find((a) => a.id === entry.attributeId);
    if (!attr) throw new UserFacingError("An attribute no longer exists.");
    const result = validateAttributeValue(toDef(attr), entry.value);
    if (!result.ok) throw new UserFacingError(result.message);
    if (result.value) toStore.push({ attributeId: attr.id, stored: result.value });
  }
  await prisma.$transaction(async (tx) => {
    if (!(await tx.product.findUnique({ where: { id: productId }, select: { id: true } }))) throw new UserFacingError("Product not found.");
    await tx.productAttributeValue.deleteMany({ where: { productId } });
    await tx.productAttributeOption.deleteMany({ where: { productId } });
    for (const { attributeId, stored } of toStore) {
      if (stored.kind === "options") {
        for (const optionId of stored.optionIds) await tx.productAttributeOption.create({ data: { productId, attributeId, optionId } });
      } else {
        await tx.productAttributeValue.create({
          data: {
            productId,
            attributeId,
            valueText: stored.kind === "text" ? stored.value : null,
            valueNumber: stored.kind === "number" ? stored.value : null,
            valueBoolean: stored.kind === "boolean" ? stored.value : null,
          },
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// PUBLIC — specifications on the product page, filters on the shop
// ---------------------------------------------------------------------------
export type PublicSpecGroup = { group: string; items: { name: string; value: string }[] };

export async function getProductSpecifications(productId: string): Promise<PublicSpecGroup[]> {
  const [values, links] = await Promise.all([
    prisma.productAttributeValue.findMany({ where: { productId, attribute: { isActive: true, showOnProduct: true } }, include: { attribute: { include: { group: true } } } }),
    prisma.productAttributeOption.findMany({ where: { productId, attribute: { isActive: true, showOnProduct: true } }, include: { attribute: { include: { group: true } }, option: true } }),
  ]);
  const rows = new Map<string, { group: string; groupSort: number; sort: number; name: string; parts: string[] }>();
  const put = (a: { id: string; name: string; sortOrder: number; group: { name: string; sortOrder: number; isActive: boolean } }, part: string) => {
    if (!a.group.isActive) return;
    const r = rows.get(a.id) ?? { group: a.group.name, groupSort: a.group.sortOrder, sort: a.sortOrder, name: a.name, parts: [] };
    r.parts.push(part);
    rows.set(a.id, r);
  };
  for (const v of values) {
    const a = v.attribute;
    const text = v.valueText ?? (v.valueNumber !== null ? `${Number(v.valueNumber)}${a.unit ? ` ${a.unit}` : ""}` : v.valueBoolean === null ? null : v.valueBoolean ? "Yes" : "No");
    if (text) put(a, text);
  }
  for (const l of links) put(l.attribute, l.option.label);
  const groups = new Map<string, { groupSort: number; items: { sort: number; name: string; value: string }[] }>();
  for (const r of rows.values()) {
    const g = groups.get(r.group) ?? { groupSort: r.groupSort, items: [] };
    g.items.push({ sort: r.sort, name: r.name, value: r.parts.join(", ") });
    groups.set(r.group, g);
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].groupSort - b[1].groupSort)
    .map(([group, g]) => ({ group, items: g.items.sort((a, b) => a.sort - b.sort).map(({ name, value }) => ({ name, value })) }));
}

export async function getFilterableAttributes() {
  const attrs = await prisma.attribute.findMany({
    where: { isActive: true, isFilterable: true, group: { isActive: true } },
    include: { options: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return attrs.map(toDef);
}

/** `?a.<slug>=…` → typed AND-clauses (unknown/hostile params are dropped by the parser). */
export async function resolveAttributeWhere(params: Record<string, string | string[] | undefined>): Promise<Prisma.ProductWhereInput[]> {
  if (!Object.keys(params).some((k) => k.startsWith("a."))) return [];
  return buildAttributeWhere(parseAttributeFilters(params, await getFilterableAttributes()));
}
