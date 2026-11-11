/**
 * Storefront theme colors.
 *
 * Admin → Settings can override the primary/secondary colors. Before the
 * redesign the database defaulted these to the OLD palette (sage #829265 /
 * #f6f1ea), so every existing store has those two values stored — not because
 * anyone chose them, but because they were the default. Applying them as
 * overrides would pin every store to the old look and hide the new design.
 *
 * So: the two legacy defaults are treated as "not customised" (the CSS design
 * tokens apply), while any OTHER stored color is a deliberate choice and wins.
 * (A store that truly wants the old sage can pick a nearby shade.)
 */
export const BRAND_PRIMARY = "#A63A5B";
export const BRAND_SECONDARY = "#F1E5D6";

export const LEGACY_DEFAULT_PRIMARY = "#829265";
export const LEGACY_DEFAULT_SECONDARY = "#f6f1ea";

const HEX = /^#[0-9a-fA-F]{6}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function custom(value: string | null | undefined, legacyDefault: string): string | null {
  const v = value?.trim();
  if (!v || !HEX.test(v) || same(v, legacyDefault)) return null;
  return v;
}

/** The colors to apply as runtime overrides (null = use the design tokens). */
export function resolveThemeOverrides(settings: { primaryColor?: string | null; secondaryColor?: string | null }) {
  return {
    primary: custom(settings.primaryColor, LEGACY_DEFAULT_PRIMARY),
    secondary: custom(settings.secondaryColor, LEGACY_DEFAULT_SECONDARY),
  };
}

/** Values to pre-fill in the settings form: the brand palette unless a real custom color is stored. */
export function themeFormDefaults(settings: { primaryColor?: string | null; secondaryColor?: string | null }) {
  const o = resolveThemeOverrides(settings);
  return { primaryColor: o.primary ?? BRAND_PRIMARY, secondaryColor: o.secondary ?? BRAND_SECONDARY };
}
