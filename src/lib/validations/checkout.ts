import { z } from "zod";
import { normalizeBdPhone } from "@/lib/advance-policy";

export const BD_PHONE_MESSAGE = "Enter a Bangladesh mobile number (01XXXXXXXXX or +8801XXXXXXXXX)";

/**
 * Checkout phones must be Bangladesh mobile numbers. The accepted spellings (01XXXXXXXXX, +8801XXXXXXXXX, and also 8801XXXXXXXXX / 008801XXXXXXXXX,
 * with spaces or dashes) are all normalised to 01XXXXXXXXX, so the stored order phone, the courier phone and the fraud-check phone are one consistent
 * value. Everything else (other countries, wrong operator prefix, wrong length) is rejected here, on the server, not only in the form.
 */
export const bdPhoneSchema = z
  .string()
  .trim()
  .refine((v) => normalizeBdPhone(v) !== null, BD_PHONE_MESSAGE)
  .transform((v) => normalizeBdPhone(v) as string);

export const addressSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required"),
  phone: z.string().trim().min(6, "Enter a valid phone number"),
  line1: z.string().trim().min(3, "Address is required"),
  line2: z.string().trim().optional().or(z.literal("")),
  city: z.string().trim().min(1, "City is required"),
  state: z.string().trim().optional().or(z.literal("")),
  postalCode: z.string().trim().optional().or(z.literal("")),
  country: z.string().trim().min(2, "Country is required"),
});
export type AddressInput = z.infer<typeof addressSchema>;

export const checkoutSchema = z
  .object({
    email: z.email("Enter a valid email address"),
    phone: bdPhoneSchema,
    // The delivery phone: the courier calls it and the fraud check looks it up, so it must be a Bangladesh mobile number.
    // (The billing address below keeps the general address rules.)
    shippingAddress: addressSchema.extend({ phone: bdPhoneSchema }),
    billingSameAsShipping: z.boolean(),
    // Not validated against addressSchema here — see superRefine below.
    // When billingSameAsShipping is true, the fields are hidden in the UI
    // but react-hook-form still submits whatever is in them (typically an
    // object of empty strings from defaultValues, not undefined), so a
    // plain `addressSchema.optional()` here would still run full
    // min-length validation on those empty strings and block submission.
    billingAddress: addressSchema.partial().optional(),
    // V1 is Cash on Delivery only. STRIPE / SSLCOMMERZ have no payment flow,
    // so they must be REJECTED here, not merely hidden in the UI.
    paymentMethod: z.literal("COD", { error: "Cash on Delivery is the only payment method currently available." }),
    deliveryZone: z.enum(["DHAKA_CITY", "OUTSIDE_DHAKA", "OTHER"]),
    couponCode: z.string().trim().optional().or(z.literal("")),
    // Opt-in delivery reward id; ownership, validity and the discount amount are all re-checked on the server.
    rewardId: z.string().trim().max(60).optional().or(z.literal("")),
    // The customer's CLAIM about an advance they sent. Staff verify it; it never counts as payment by itself.
    advanceMethod: z.enum(["BKASH", "NAGAD"]).optional(),
    advanceReference: z.string().trim().max(60).optional().or(z.literal("")),
    customerNote: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    if (data.billingSameAsShipping) return;
    const result = addressSchema.safeParse(data.billingAddress);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ["billingAddress", ...issue.path] });
      }
    }
  });
export type CheckoutInput = z.infer<typeof checkoutSchema>;
