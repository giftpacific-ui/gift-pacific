/**
 * Courier picker for the booking screens. Deliberately free of server-only imports (no crypto, no database): client components use it.
 * The types come from provider-state.ts via type-only imports, which are erased at build time.
 */
import type { CourierChoiceView } from "@/lib/courier/provider-state";

/**
 * Options of the courier picker on the booking screens (single and bulk), built from the same states the provider board shows.
 *  - First option "Automatic" (value ""): sends NO courier, so the server applies its default (COURIER_DEFAULT_PROVIDER, else the only /
 *    first configured courier). It is selected initially, so a screen never silently overrides the configured default.
 *  - Then every courier. One without an API adapter, or without credentials, is listed but DISABLED, with the reason in its text:
 *    it is visible, never pretended to be bookable, and its bookings are recorded by hand.
 */
export type CourierPickerOption = { value: string; label: string; disabled: boolean };

export function courierPickerOptions(
  choices: CourierChoiceView[],
  defaultChoice: { key: string | null; message: string },
): CourierPickerOption[] {
  const def = defaultChoice.key ? choices.find((c) => c.key === defaultChoice.key) : undefined;
  const auto: CourierPickerOption = def
    ? { value: "", label: `Automatic — ${def.label} (default)`, disabled: false }
    : { value: "", label: "Automatic — no default courier available", disabled: true };
  return [auto, ...choices.map((c) => ({ value: c.key, label: c.optionText, disabled: !c.apiBookable }))];
}

/** The option a picker starts on: Automatic when a default exists, else the first courier that can actually be booked, else nothing. */
export function initialPickerValue(options: CourierPickerOption[]): string {
  return options.find((o) => !o.disabled)?.value ?? "";
}
