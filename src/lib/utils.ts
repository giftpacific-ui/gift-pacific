import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a number (in major currency units) as a display price string. */
export function formatPrice(
  amount: number,
  options: { currencySymbol?: string; locale?: string } = {},
) {
  const { currencySymbol = "৳", locale = "en-US" } = options;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${currencySymbol}${formatted}`;
}

export function formatDate(date: Date | string) {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(d);
}

/**
 * Strips HTML tags from a rich-text field for plain-text contexts (meta
 * descriptions, JSON-LD, search snippets) where markup would otherwise
 * show up as literal text. Collapses whitespace left behind by removed
 * block-level tags.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
