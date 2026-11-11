/** Pure server-side validation for customer reviews (plain text only). */
export const REVIEW_TITLE_MAX = 100;
export const REVIEW_BODY_MIN = 10;
export const REVIEW_BODY_MAX = 2000;

export type ReviewInput = { rating: unknown; title?: unknown; body?: unknown };
export type ReviewValidation =
  | { ok: true; rating: number; title: string | null; body: string }
  | { ok: false; message: string };

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") // control chars (keep \n and \t)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function validateReview(input: ReviewInput): ReviewValidation {
  const { rating } = input;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, message: "Please choose a rating from 1 to 5 stars." };
  }
  if (input.title !== undefined && input.title !== null && typeof input.title !== "string") {
    return { ok: false, message: "The review title is invalid." };
  }
  if (typeof input.body !== "string") {
    return { ok: false, message: "Please write a few words about the product." };
  }
  const title = typeof input.title === "string" ? cleanText(input.title.replace(/\s+/g, " ")) : "";
  if (title.length > REVIEW_TITLE_MAX) {
    return { ok: false, message: `The title can be at most ${REVIEW_TITLE_MAX} characters.` };
  }
  const body = cleanText(input.body);
  if (body.length < REVIEW_BODY_MIN) {
    return { ok: false, message: `Please write at least ${REVIEW_BODY_MIN} characters.` };
  }
  if (body.length > REVIEW_BODY_MAX) {
    return { ok: false, message: `Reviews can be at most ${REVIEW_BODY_MAX} characters.` };
  }
  return { ok: true, rating, title: title || null, body };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
import type { Prisma } from "@prisma/client";

export type ReviewStatusName = "PENDING" | "APPROVED" | "REJECTED" | "HIDDEN";
export type ModerationDecision = "approve" | "reject" | "hide" | "unhide";

/** A review is earned by an item of a DELIVERED order. Returned/refunded orders revoke it. */
export const REVIEW_ELIGIBLE_ORDER_STATUS = "DELIVERED";
export const isOrderEligibleForReview = (orderStatus: string) => orderStatus === REVIEW_ELIGIBLE_ORDER_STATUS;

/**
 * Public = approved AND its order item still counts. Evaluated at READ time, so a refund or
 * return unpublishes the review automatically (no background job to forget or fail), and it
 * reappears if the refund is rejected and the order returns to DELIVERED.
 * Legacy reviews (no order item recorded) are grandfathered while approved.
 */
export function publicReviewWhere(): Prisma.ReviewWhereInput {
  return {
    status: "APPROVED",
    OR: [{ orderItemId: null }, { orderItem: { order: { status: REVIEW_ELIGIBLE_ORDER_STATUS } } }],
  };
}

export function isPubliclyVisible(review: { status: string; orderStatus: string | null }): boolean {
  return review.status === "APPROVED" && (review.orderStatus === null || isOrderEligibleForReview(review.orderStatus));
}

/** The status an admin decision leads to, or null if it does not apply to the current status. */
export function nextReviewStatus(current: ReviewStatusName, decision: ModerationDecision): ReviewStatusName | null {
  switch (decision) {
    case "approve": return current === "PENDING" || current === "REJECTED" || current === "HIDDEN" ? "APPROVED" : null;
    case "reject": return current === "PENDING" || current === "APPROVED" || current === "HIDDEN" ? "REJECTED" : null;
    case "hide": return current === "APPROVED" ? "HIDDEN" : null;
    case "unhide": return current === "HIDDEN" ? "APPROVED" : null;
  }
}

/** What the AUTHOR sees about their own review (they always see it, whatever its status). */
export function authorReviewLabel(review: { status: string; orderStatus: string | null }): string {
  if (review.status === "PENDING") return "Awaiting approval — only you can see this";
  if (review.status === "REJECTED") return "Not published";
  if (review.status === "HIDDEN") return "Hidden by the store — only you can see this";
  return isPubliclyVisible(review) ? "Published" : "Unpublished because the order was returned or refunded";
}

/**
 * A customer may edit their own review while it is PENDING or APPROVED and its order still counts (delivered).
 * Rejected/hidden reviews stay closed (a rejection must not be bypassed by editing), and a refunded/returned order revokes it.
 */
export function canEditReview(status: ReviewStatusName, orderStatus: string | null): boolean {
  return (status === "PENDING" || status === "APPROVED") && (orderStatus === null || isOrderEligibleForReview(orderStatus));
}
