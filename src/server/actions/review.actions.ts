"use server";

import { revalidatePath } from "next/cache";
import { toUserMessage } from "@/lib/errors";
import { getSession } from "@/lib/auth/current-user";
import { RATE_LIMITS, consumeRateLimit, throttledMessage } from "@/lib/rate-limit";
import { getMyReviewForProduct, getReviewEligibility, submitReview, updateMyReview, type MyReview, type ReviewEligibility } from "@/server/services/review.service";

export async function getReviewEligibilityAction(productId: string): Promise<ReviewEligibility> {
  return getReviewEligibility(productId);
}

export async function submitReviewAction(
  productId: string,
  input: { rating: number; title?: string; body: string },
): Promise<{ success: true } | { success: false; message: string }> {
    try {
    const session = await getSession();
    if (session) {
      const throttle = await consumeRateLimit(RATE_LIMITS.review, [session.sub]);
      if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };
    }
    await submitReview(productId, input);
    revalidatePath("/admin/reviews");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not submit your review.") };
  }
}

/** The signed-in customer's own review of this product, in any status (never anyone else's). */
export async function getMyReviewAction(productId: string): Promise<MyReview | null> {
  return getMyReviewForProduct(productId);
}

export async function updateMyReviewAction(
  productId: string,
  input: { rating: number; title?: string; body: string },
): Promise<{ success: true } | { success: false; message: string }> {
  try {
    const session = await getSession();
    if (session) {
      const throttle = await consumeRateLimit(RATE_LIMITS.review, [session.sub]);
      if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };
    }
    await updateMyReview(productId, input);
    revalidatePath("/admin/reviews");
    revalidatePath("/products/[slug]", "page");
    revalidatePath("/account/reviews");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not update your review.") };
  }
}
