/**
 * V1 field types: text, textarea, date, color, dropdown. IMAGE_UPLOAD was
 * removed on purpose (the customer form never implemented it); do not re-add
 * it without building the whole flow — a regression test guards this.
 */
/**
 * Personalization (customization) rules.
 */
export const CUSTOMIZATION_FIELD_TYPES = [
  "TEXT",
  "TEXTAREA",
  "DATE",
  "COLOR",
  "SELECT",
] as const;
export type CustomizationFieldTypeName =
  (typeof CUSTOMIZATION_FIELD_TYPES)[number];

export const OPTION_FIELD_TYPES: readonly CustomizationFieldTypeName[] = [
  "SELECT",
  "COLOR",
];
export const TEXT_FIELD_TYPES: readonly CustomizationFieldTypeName[] = [
  "TEXT",
  "TEXTAREA",
];

export const DEFAULT_TEXT_MAX = 200;
export const DEFAULT_TEXTAREA_MAX = 1000;
export const MAX_FIELD_OPTIONS = 30;
export const MAX_OPTION_LENGTH = 60;

export type CustomizationFieldConfig = {
  label: string;
  fieldKey: string;
  type: CustomizationFieldTypeName;
  isRequired: boolean;
  options: readonly string[];
  maxLength: number | null;
};

export type CustomizationResult =
  | { ok: true; value: Record<string, string> | null }
  | { ok: false; message: string };

function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates what a customer submitted for a product's personalization fields
 * against that product's configured fields. Server-authoritative: the cart
 * must never store arbitrary client-supplied JSON.
 */
export function validateCustomizationInput(
  fields: readonly CustomizationFieldConfig[],
  raw: unknown,
): CustomizationResult {
  const hasInput =
    raw !== null &&
    raw !== undefined &&
    !(isPlainObject(raw) && Object.keys(raw).length === 0);

  if (fields.length === 0) {
    return hasInput
      ? { ok: false, message: "This product can't be personalized." }
      : { ok: true, value: null };
  }

  if (raw !== null && raw !== undefined && !isPlainObject(raw)) {
    return { ok: false, message: "Invalid personalization details." };
  }
  const input = (raw ?? {}) as Record<string, unknown>;

  const known = new Set(fields.map((f) => f.fieldKey));
  for (const key of Object.keys(input)) {
    if (!known.has(key))
      return { ok: false, message: "Invalid personalization details." };
  }

  const value: Record<string, string> = {};
  for (const field of fields) {
    const rawValue = input[field.fieldKey];
    if (
      rawValue !== undefined &&
      rawValue !== null &&
      typeof rawValue !== "string"
    ) {
      return { ok: false, message: `${field.label} is invalid.` };
    }
    const text = (rawValue ?? "").trim();

    if (text === "") {
      if (field.isRequired)
        return { ok: false, message: `${field.label} is required.` };
      continue;
    }

    switch (field.type) {
      case "TEXT":
      case "TEXTAREA": {
        const limit =
          field.maxLength ??
          (field.type === "TEXT" ? DEFAULT_TEXT_MAX : DEFAULT_TEXTAREA_MAX);
        if (text.length > limit) {
          return {
            ok: false,
            message: `${field.label} must be ${limit} characters or fewer.`,
          };
        }
        break;
      }
      case "DATE":
        if (!isValidCalendarDate(text)) {
          return { ok: false, message: `${field.label} must be a valid date.` };
        }
        break;
      case "SELECT":
      case "COLOR":
        if (!field.options.includes(text)) {
          return {
            ok: false,
            message: `Please choose a valid option for ${field.label}.`,
          };
        }
        break;
      default:
        return { ok: false, message: `${field.label} is invalid.` };
    }
    value[field.fieldKey] = text;
  }

  return { ok: true, value: Object.keys(value).length > 0 ? value : null };
}

/** Personalization only applies to PERSONALIZED products; for any other type the configured fields are ignored. */
export function sellableCustomizationFields(product: {
  type: string;
  customizationFields: readonly CustomizationFieldConfig[];
}): CustomizationFieldConfig[] {
  return product.type === "PERSONALIZED"
    ? [...product.customizationFields]
    : [];
}
