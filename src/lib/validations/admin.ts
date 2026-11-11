import { z } from "zod";
import { isSafeHttpUrl, isSafeImageUrl, isSafeLinkTarget } from "@/lib/url-safety";
import {
  GA4_ID_PATTERN,
  GTM_ID_PATTERN,
  LINKEDIN_PARTNER_ID_PATTERN,
  META_PIXEL_ID_PATTERN,
  TIKTOK_PIXEL_ID_PATTERN,
} from "@/lib/analytics/ids";

/**
 * For any admin-configurable URL that ends up rendered as a link/src on
 * the public site (banner CTAs, social links, product video links).
 * Allows http(s), relative paths, and empty — rejects javascript:, data:,
 * vbscript:, and any other scheme, which is what actually matters here
 * (an admin-set `javascript:` href would execute on every visitor who
 * clicks it).
 */
const safeUrlSchema = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .refine((value) => !value || isSafeLinkTarget(value), {
    message: "Enter a valid http(s) or relative URL",
  });

/*
 * NOTE on optional numeric fields: the admin forms send "" for a blank
 * input. `z.coerce.number()` would turn "" into 0 (a blank "usage limit"
 * became limit 0 = a coupon nobody can use). So the "" literal is matched
 * FIRST and stays "", and the server maps it to null.
 */

/** Absolute http(s) only (no relative paths) — product videos. */
const httpUrlSchema = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .refine((value) => !value || isSafeHttpUrl(value), { message: "Enter a valid http(s) URL" });

/** Image URL stored in the DB and used as <img>/next-image src. */
export const imageUrlSchema = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .refine((value) => !value || isSafeImageUrl(value), { message: "Enter a valid http(s) image URL" });

export const productFormSchema = z.object({
  name: z.string().trim().min(2),
  slug: z
    .string()
    .trim()
    .min(2)
    .regex(
      /^[a-z0-9-]+$/,
      "Slug must be lowercase letters, numbers, and hyphens only",
    ),
  shortDescription: z.string().trim().max(300).optional().or(z.literal("")),
  description: z.string().trim().min(10),
  sku: z.string().trim().optional().or(z.literal("")),
  brand: z.string().trim().optional().or(z.literal("")),
  type: z.enum(["STANDARD", "VARIANT", "PERSONALIZED", "BUNDLE"]),
  // Explicit product type: SINGLE (a normal product) or COMBO (made of other products).
  kind: z.enum(["SINGLE", "COMBO"]).optional(), // derived from `type` when omitted
  comboMode: z.enum(["FIXED", "CUSTOMIZABLE"]).optional().or(z.literal("")),
  comboPricing: z.enum(["FIXED_PRICE", "COMPONENT_SUM"]).optional().or(z.literal("")),
  comboStockPolicy: z.enum(["OWN_STOCK", "COMPONENTS"]).optional().or(z.literal("")),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
  badges: z.array(
    z.enum([
      "NEW",
      "BEST_SELLER",
      "LIMITED_EDITION",
      "HANDMADE",
      "PERSONALIZED",
      "SALE",
    ]),
  ),
  categoryId: z.string().optional().or(z.literal("")),
  price: z.coerce.number().min(0),
  compareAtPrice: z.literal("").or(z.coerce.number().min(0)).optional(),
  costPrice: z.literal("").or(z.coerce.number().min(0)).optional(),
  stock: z.coerce.number().int().min(0),
  lowStockThreshold: z.coerce.number().int().min(0),
  // The stock the form was LOADED with. A save only changes stock when the
  // admin edited it, and then by the difference (see adminUpdateProduct).
  loadedStock: z.coerce.number().int().optional(),
  allowBackorder: z.boolean(),
  // Max units that may be waiting to be sourced at once ("" = no cap). Only used when backorder/procurement is on.
  procurementLimit: z.literal("").or(z.coerce.number().int().min(0).max(1_000_000)).optional(),
  backorderNote: z.string().trim().max(200).optional(),
  trackInventory: z.boolean(),
  isFeatured: z.boolean(),
  videoUrl: httpUrlSchema,
  weightGrams: z.literal("").or(z.coerce.number().int().min(0)).optional(),
  metaTitle: z.string().trim().max(120).optional().or(z.literal("")),
  metaDescription: z.string().trim().max(300).optional().or(z.literal("")),
  metaKeywords: z.array(z.string().max(60)).max(20).optional(),
  // Phase 5: share/search image (validated http(s) URL, never an arbitrary scheme) and the index switch.
  seoImage: imageUrlSchema,
  seoNoIndex: z.boolean().optional(),
});
export type ProductFormValues = z.infer<typeof productFormSchema>;

export const variantFormSchema = z.object({
  name: z.string().trim().min(1),
  sku: z.string().trim().min(1),
  price: z.coerce.number().min(0),
  optionsJson: z.string().min(2), // JSON object string, e.g. {"Color":"Terracotta"}
  stock: z.coerce.number().int().min(0),
  loadedStock: z.coerce.number().int().optional(),
  image: imageUrlSchema,
  allowBackorder: z.boolean(),
  isDefault: z.boolean(),
});

export const customizationFieldFormSchema = z.object({
  label: z.string().trim().min(1),
  fieldKey: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_]+$/, "Use letters, numbers, and underscores only"),
  // IMAGE_UPLOAD was removed in V1: the customer form never implemented it.
  type: z.enum(["TEXT", "TEXTAREA", "DATE", "COLOR", "SELECT"]),
  isRequired: z.boolean(),
  optionsCsv: z.string().optional().or(z.literal("")),
  maxLength: z.literal("").or(z.coerce.number().int().min(1)).optional(),
  sortOrder: z.coerce.number().int().min(0),
});

export const categoryFormSchema = z.object({
  name: z.string().trim().min(2),
  slug: z
    .string()
    .trim()
    .min(2)
    .regex(/^[a-z0-9-]+$/),
  description: z.string().trim().optional().or(z.literal("")),
  metaTitle: z.string().trim().max(120).optional().or(z.literal("")),
  metaDescription: z.string().trim().max(300).optional().or(z.literal("")),
  metaKeywords: z.array(z.string().max(60)).max(20).optional(),
  seoNoIndex: z.boolean().optional(),
  image: imageUrlSchema,
  imageCloudinaryPublicId: z.string().trim().optional().nullable(),
  parentId: z.string().optional().or(z.literal("")),
  isFeatured: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.coerce.number().int().min(0),
});

export const couponFormSchema = z.object({
  code: z.string().trim().min(3).toUpperCase(),
  type: z.enum(["PERCENTAGE", "FIXED"]),
  value: z.coerce.number().min(0),
  minPurchase: z.literal("").or(z.coerce.number().min(0)).optional(),
  maxDiscount: z.literal("").or(z.coerce.number().min(0)).optional(),
  usageLimit: z.literal("").or(z.coerce.number().int().min(0)).optional(),
  perUserLimit: z.literal("").or(z.coerce.number().int().min(0)).optional(),
  startsAt: z.string().optional().or(z.literal("")),
  endsAt: z.string().optional().or(z.literal("")),
  isActive: z.boolean(),
});

// src/lib/validations/admin.ts

export const storeSettingsFormSchema = z.object({
  storeName: z.string().trim().min(1),
  storeEmail: z.string().email().optional().or(z.literal("")),
  storePhone: z.string().trim().optional().or(z.literal("")),
  storeAddress: z.string().trim().optional().or(z.literal("")),
  logoUrl: imageUrlSchema,
  logoCloudinaryPublicId: z.string().trim().nullable().optional(),
  faviconUrl: imageUrlSchema,
  faviconCloudinaryPublicId: z.string().trim().nullable().optional(),
  primaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #A63A5B"),
  secondaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #F1E5D6"),
  currencyCode: z.string().trim().min(2).max(6),
  currencySymbol: z.string().trim().min(1).max(4),
  instagramUrl: safeUrlSchema,
  facebookUrl: safeUrlSchema,
  whatsappUrl: safeUrlSchema,
  tiktokUrl: safeUrlSchema,
  deliveryChargeDhaka: z.coerce.number().min(0),
  deliveryChargeOutsideDhaka: z.coerce.number().min(0),
  deliveryChargeOther: z.coerce.number().min(0),
  shippingFlatRate: z.coerce.number().min(0).optional(),

  // Empty string, null ba undefined ke undefined-e transform korbe
  freeShippingThreshold: z.preprocess(
    (val) =>
      val === "" || val === null || val === undefined ? undefined : Number(val),
    z.number().min(0).optional(),
  ),

  taxRatePercent: z.coerce.number().min(0).max(100),
  // Interpolated into inline <script> snippets — must match real ID formats.
  gtmId: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || GA4_ID_PATTERN.test(v) || GTM_ID_PATTERN.test(v), {
      message: "Use a GA4 ID (G-XXXXXXXXXX) or a GTM container ID (GTM-XXXXXXX)",
    }),
  metaPixelId: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
        .refine((v) => !v || META_PIXEL_ID_PATTERN.test(v), {
      message: "Meta Pixel IDs are 5–20 digits",
    }),
  tiktokPixelId: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || TIKTOK_PIXEL_ID_PATTERN.test(v), {
      message: "TikTok Pixel IDs are 10–30 capital letters/digits",
    }),
  linkedinPartnerId: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || LINKEDIN_PARTNER_ID_PATTERN.test(v), {
      message: "LinkedIn Partner IDs are 4–12 digits",
    }),
  // OFF: trackers load as before. OPT_IN: nothing loads until the visitor accepts.
  consentMode: z.enum(["OFF", "OPT_IN"]).default("OFF"),
  // Site / SEO
  seoTitleTemplate: z.string().trim().max(120).optional().or(z.literal("")),
  seoDescription: z.string().trim().max(300).optional().or(z.literal("")),
  seoKeywords: z.array(z.string().max(60)).max(20).optional(),
  ogImageUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isSafeHttpUrl(v), { message: "Enter a valid https:// image link" }),
});

export const bannerFormSchema = z.object({
  title: z.string().trim().min(1),
  subtitle: z.string().trim().optional().or(z.literal("")),
  imageUrl: z
    .string()
    .trim()
    .min(1)
    .refine((v) => isSafeImageUrl(v), { message: "Enter a valid http(s) image URL" }),
  cloudinaryPublicId: z.string().trim().nullable().optional(),
  ctaLabel: z.string().trim().optional().or(z.literal("")),
  ctaHref: safeUrlSchema,
  placement: z.enum(["HERO", "PROMO_STRIP", "MID_PAGE", "CAMPAIGN", "POPUP"]),
  sortOrder: z.coerce.number().int().min(0),
  isActive: z.boolean(),
  startsAt: z.string().optional().or(z.literal("")),
  endsAt: z.string().optional().or(z.literal("")),
});

// The image is uploaded and tracked outside react-hook-form (via
// SingleImageUploader + local state), so the client-side resolver
// validates everything except imageUrl/cloudinaryPublicId — those are
// merged in right before calling the server action, which validates the
// full bannerFormSchema server-side.
export const bannerFormClientSchema = bannerFormSchema.omit({
  imageUrl: true,
  cloudinaryPublicId: true,
});
