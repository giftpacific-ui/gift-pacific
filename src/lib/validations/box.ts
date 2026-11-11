import { z } from "zod";
import { isSafeHttpUrl } from "@/lib/url-safety";
import { normalizeKeywords } from "@/lib/seo-keywords";

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);

export const boxSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  slug: z.string().trim().max(80).optional().default(""),
  description: optionalText(2000),
  imageUrl: z.union([z.string().trim().max(500).refine((v) => isSafeHttpUrl(v), "Enter a valid https:// link"), z.literal("")]).optional().transform((v) => (v ? v : null)),
  imagePublicId: optionalText(300),
  // Explicit on purpose: 0 means "included free", anything above is the box's own price (BDT).
  price: z.number().finite().min(0, "Price cannot be negative").max(10_000_000).transform((v) => Math.round(v * 100) / 100),
  sortOrder: z.number().int().min(0).max(9999),
  isActive: z.boolean(),
  // Box-specific inventory (kept on the hidden managed product that the cart/orders/stock code already understands).
  stock: z.number().int().min(0).max(1_000_000),
  allowBackorder: z.boolean().optional().default(false),
  seoTitle: optionalText(120),
  seoDescription: optionalText(300),
  seoKeywords: z.array(z.string()).max(20).optional().transform((v) => normalizeKeywords(v)),
}).transform((v) => ({ ...v, slug: slugify(v.slug || v.name) }))
  .refine((v) => v.slug.length > 0, { message: "Could not build a URL slug from that name", path: ["slug"] });

export type BoxInput = z.input<typeof boxSchema>;
