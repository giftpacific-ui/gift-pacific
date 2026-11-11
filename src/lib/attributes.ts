import type { Prisma } from "@prisma/client";

/**
 * Descriptive product attributes (Material, Voltage, Dimensions…). Pure rules, no I/O.
 *
 * Attributes are DESCRIPTIVE ONLY: they never carry stock, price or a SKU — purchasable
 * options stay on ProductVariant. Measurements/dimensions are NUMBER + a canonical unit.
 * Filtering is built from typed values validated against the attribute's own definition;
 * there is no raw SQL and no JSON-path querying anywhere.
 */
export type AttributeValueType = "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT" | "MULTI_SELECT";

export type AttributeDef = {
  id: string;
  slug: string;
  name: string;
  valueType: AttributeValueType;
  unit: string | null;
  minNumber: number | null;
  maxNumber: number | null;
  maxLength: number | null;
  isRequired: boolean;
  options: { id: string; value: string; label: string }[];
};

export const DEFAULT_TEXT_MAX = 500;
export const MAX_MULTI_VALUES = 20;
export const MAX_FILTERS = 6;
export const MAX_FILTER_VALUES = 10;

export type StoredValue =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "options"; optionIds: string[] };

export type ValueResult = { ok: true; value: StoredValue | null } | { ok: false; message: string };

const isBlank = (raw: unknown) =>
  raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0);

/** Validates an untrusted value against the attribute definition. `value: null` = "not set". */
export function validateAttributeValue(def: AttributeDef, raw: unknown): ValueResult {
  if (isBlank(raw)) {
    return def.isRequired ? { ok: false, message: `${def.name} is required.` } : { ok: true, value: null };
  }
  switch (def.valueType) {
    case "TEXT": {
      if (typeof raw !== "string") return { ok: false, message: `${def.name} must be text.` };
      const value = raw.trim();
      const max = def.maxLength ?? DEFAULT_TEXT_MAX;
      if (value.length > max) return { ok: false, message: `${def.name} can be at most ${max} characters.` };
      return { ok: true, value: { kind: "text", value } };
    }
    case "NUMBER": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(n)) return { ok: false, message: `${def.name} must be a number.` };
      if (Math.abs(n) >= 1e10) return { ok: false, message: `${def.name} is too large.` };
      if (Math.round(n * 10000) / 10000 !== n) return { ok: false, message: `${def.name} allows at most 4 decimal places.` };
      if (def.minNumber !== null && n < def.minNumber) return { ok: false, message: `${def.name} must be at least ${def.minNumber}.` };
      if (def.maxNumber !== null && n > def.maxNumber) return { ok: false, message: `${def.name} must be at most ${def.maxNumber}.` };
      return { ok: true, value: { kind: "number", value: n } };
    }
    case "BOOLEAN": {
      if (raw === true || raw === "true") return { ok: true, value: { kind: "boolean", value: true } };
      if (raw === false || raw === "false") return { ok: true, value: { kind: "boolean", value: false } };
      return { ok: false, message: `${def.name} must be yes or no.` };
    }
    case "SELECT": {
      if (typeof raw !== "string" || !def.options.some((o) => o.id === raw)) return { ok: false, message: `Choose a valid option for ${def.name}.` };
      return { ok: true, value: { kind: "options", optionIds: [raw] } };
    }
    case "MULTI_SELECT": {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) return { ok: false, message: `Choose valid options for ${def.name}.` };
      const ids = [...new Set(raw as string[])];
      if (ids.length > MAX_MULTI_VALUES) return { ok: false, message: `Choose at most ${MAX_MULTI_VALUES} options for ${def.name}.` };
      if (ids.some((id) => !def.options.some((o) => o.id === id))) return { ok: false, message: `Choose valid options for ${def.name}.` };
      return { ok: true, value: { kind: "options", optionIds: ids } };
    }
  }
}

/** Admin definition rules (slugs, units, bounds, allowed type for filtering). */
export function validateAttributeDefinition(input: {
  name: string;
  valueType: AttributeValueType;
  unit?: string | null;
  minNumber?: number | null;
  maxNumber?: number | null;
  maxLength?: number | null;
  isFilterable?: boolean;
}): string | null {
  if (!input.name.trim()) return "Name is required.";
  if (input.name.length > 80) return "Name is too long.";
  if (input.unit && input.valueType !== "NUMBER") return "Only number attributes have a unit.";
  if (input.unit && input.unit.length > 12) return "Unit is too long (e.g. cm, kg, W).";
  if (input.valueType !== "NUMBER" && (input.minNumber != null || input.maxNumber != null)) return "Only number attributes have a range.";
  if (input.minNumber != null && input.maxNumber != null && input.minNumber > input.maxNumber) return "Minimum cannot be above maximum.";
  if (input.maxLength != null && (input.valueType !== "TEXT" || !Number.isInteger(input.maxLength) || input.maxLength < 1 || input.maxLength > 2000)) {
    return "Maximum length only applies to text (1–2000).";
  }
  if (input.isFilterable && input.valueType === "TEXT") return "Free-text attributes cannot be used as filters.";
  return null;
}

export const slugifyKey = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// ---------------------------------------------------------------------------
// Filters:  ?a.<attribute-slug>=<values>   (options: value1,value2 · number: 10..50 · boolean: true)
// ---------------------------------------------------------------------------
export type AttributeFilter =
  | { attributeId: string; kind: "options"; optionIds: string[] }
  | { attributeId: string; kind: "range"; min: number | null; max: number | null }
  | { attributeId: string; kind: "boolean"; value: boolean };

/**
 * Turns untrusted query params into typed filters. Anything that does not match a FILTERABLE
 * attribute definition (unknown slug, unknown option, bad number, TEXT attribute) is dropped.
 */
export function parseAttributeFilters(
  params: Record<string, string | string[] | undefined>,
  defs: (AttributeDef & { isFilterable: boolean })[],
): AttributeFilter[] {
  const out: AttributeFilter[] = [];
  for (const [key, rawValue] of Object.entries(params)) {
    if (!key.startsWith("a.") || out.length >= MAX_FILTERS) continue;
    const def = defs.find((d) => d.isFilterable && d.slug === key.slice(2));
    if (!def) continue;
    const raw = (Array.isArray(rawValue) ? rawValue.join(",") : rawValue ?? "").trim();
    if (!raw || raw.length > 300) continue;
    if (def.valueType === "SELECT" || def.valueType === "MULTI_SELECT") {
      const ids = [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))]
        .slice(0, MAX_FILTER_VALUES)
        .map((v) => def.options.find((o) => o.value === v)?.id)
        .filter((id): id is string => !!id);
      if (ids.length) out.push({ attributeId: def.id, kind: "options", optionIds: ids });
    } else if (def.valueType === "NUMBER") {
      const m = /^(-?\d+(?:\.\d{1,4})?)?\.\.(-?\d+(?:\.\d{1,4})?)?$/.exec(raw);
      if (!m || (m[1] === undefined && m[2] === undefined)) continue;
      const min = m[1] === undefined ? null : Number(m[1]);
      const max = m[2] === undefined ? null : Number(m[2]);
      if (min !== null && max !== null && min > max) continue;
      out.push({ attributeId: def.id, kind: "range", min, max });
    } else if (def.valueType === "BOOLEAN") {
      if (raw === "true" || raw === "false") out.push({ attributeId: def.id, kind: "boolean", value: raw === "true" });
    }
  }
  return out;
}

/** One AND-clause per filter, built only from typed Prisma inputs — never raw SQL. */
export function buildAttributeWhere(filters: AttributeFilter[]): Prisma.ProductWhereInput[] {
  return filters.map((f): Prisma.ProductWhereInput => {
    if (f.kind === "options") return { attributeOptions: { some: { attributeId: f.attributeId, optionId: { in: f.optionIds } } } };
    if (f.kind === "range") {
      return {
        attributeValues: {
          some: { attributeId: f.attributeId, valueNumber: { ...(f.min !== null ? { gte: f.min } : {}), ...(f.max !== null ? { lte: f.max } : {}) } },
        },
      };
    }
    return { attributeValues: { some: { attributeId: f.attributeId, valueBoolean: f.value } } };
  });
}

/** Human-readable value for the product page. */
export function displayAttributeValue(def: Pick<AttributeDef, "valueType" | "unit">, stored: StoredValue | { labels: string[] } | null): string | null {
  if (!stored) return null;
  if ("labels" in stored) return stored.labels.join(", ") || null;
  switch (stored.kind) {
    case "text": return stored.value;
    case "number": return def.unit ? `${stored.value} ${def.unit}` : String(stored.value);
    case "boolean": return stored.value ? "Yes" : "No";
    case "options": return null;
  }
}
