import { z } from "zod";

/**
 * Centralized, validated environment configuration.
 * Import `env` instead of reading `process.env` directly anywhere else in the app,
 * so misconfiguration fails fast and loudly at boot instead of silently at runtime.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Session signing secret — must be a long random string in production.
  AUTH_SECRET: z
    .string()
    .min(16, "AUTH_SECRET must be at least 16 characters"),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_CURRENCY: z.string().default("BDT"),
  NEXT_PUBLIC_CURRENCY_SYMBOL: z.string().default("৳"),

  // Optional integrations — only required if the corresponding feature is enabled.
  NEXT_PUBLIC_GTM_ID: z.string().optional(),
  NEXT_PUBLIC_META_PIXEL_ID: z.string().optional(),
  META_CONVERSIONS_API_TOKEN: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  SSLCOMMERZ_STORE_ID: z.string().optional(),
  SSLCOMMERZ_STORE_PASSWORD: z.string().optional(),
  SSLCOMMERZ_IS_LIVE: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  UPLOAD_PROVIDER: z.enum(["local", "cloudinary"]).default("local"),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      "❌ Invalid environment variables:",
      parsed.error.flatten().fieldErrors,
    );
    throw new Error("Invalid environment variables — check .env against .env.example");
  }
  return parsed.data;
}

export const env = loadEnv();
