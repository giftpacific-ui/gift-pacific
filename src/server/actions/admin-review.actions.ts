"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { adminModerateReview } from "@/server/services/admin-review.service";
import type { ModerationDecision } from "@/lib/review-rules";
import type { AdminActionResult } from "@/server/actions/admin-product.actions";

const DECISIONS: ModerationDecision[] = ["approve", "reject", "hide", "unhide"];

export async function moderateReviewAction(
  reviewId: string,
  decision: ModerationDecision,
  note?: string,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  if (!DECISIONS.includes(decision)) return { success: false, message: "Invalid decision." };
  try {
    await adminModerateReview(reviewId, decision, admin.id, note);
    revalidatePath("/admin/reviews");
    // Approved reviews show on the product page.
    revalidatePath("/products/[slug]", "page");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not update the review.") };
  }
}
