import "server-only";
import { notifyUser } from "@/server/services/notification.service";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { isPubliclyVisible, nextReviewStatus, type ModerationDecision, type ReviewStatusName } from "@/lib/review-rules";
import type { Prisma } from "@prisma/client";

export type ReviewFilter = "pending" | "approved" | "rejected" | "hidden";

export function reviewWhere(filter: ReviewFilter): Prisma.ReviewWhereInput {
  switch (filter) {
    case "approved": return { status: "APPROVED" };
    case "rejected": return { status: "REJECTED" };
    case "hidden": return { status: "HIDDEN" };
    default: return { status: "PENDING" };
  }
}

export async function adminListReviews(filter: ReviewFilter, page = 1, pageSize = 20) {
  const where = reviewWhere(filter);
  const safePage = Number.isInteger(page) && page > 0 ? Math.min(page, 10_000) : 1;
  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (safePage - 1) * pageSize,
      take: pageSize,
      include: {
        product: { select: { name: true, slug: true } },
        user: { select: { name: true, email: true } },
        orderItem: { select: { order: { select: { orderNumber: true, status: true } } } },
        events: { orderBy: { createdAt: "desc" }, take: 8 },
      },
    }),
    prisma.review.count({ where }),
  ]);
  const items = rows.map((r) => {
    const orderStatus = r.orderItem?.order.status ?? null;
    return {
      ...r,
      orderStatus,
      orderNumber: r.orderItem?.order.orderNumber ?? null,
      publiclyVisible: isPubliclyVisible({ status: r.status, orderStatus }),
    };
  });
  return { items, total, page: safePage, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function adminCountPendingReviews() {
  return prisma.review.count({ where: reviewWhere("pending") });
}

/**
 * Applies a moderation decision. The status change is a claim on the CURRENT status (so two
 * admins cannot both act on stale state) and writes one history row in the same transaction.
 * `isApproved`/`rejectedAt` are kept in sync for older code paths.
 */
export async function adminModerateReview(
  reviewId: string,
  decision: ModerationDecision,
  actorId: string | null = null,
  note?: string,
) {
  if (!["approve", "reject", "hide", "unhide"].includes(decision)) throw new UserFacingError("Invalid decision.");
  await prisma.$transaction(async (tx) => {
    const review = await tx.review.findUnique({ where: { id: reviewId }, select: { status: true, userId: true, product: { select: { name: true, slug: true } } } });
    if (!review) throw new UserFacingError("Review not found.");
    const next = nextReviewStatus(review.status as ReviewStatusName, decision);
    if (!next) throw new UserFacingError("That action does not apply to this review's current state.");
    const claimed = await tx.review.updateMany({
      where: { id: reviewId, status: review.status },
      data: { status: next, isApproved: next === "APPROVED", rejectedAt: next === "REJECTED" ? new Date() : null },
    });
    if (claimed.count !== 1) throw new UserFacingError("This review was just changed by someone else. Reload and try again.");
    await tx.reviewModerationEvent.create({
      data: { reviewId, action: decision.toUpperCase(), actorId, note: note?.trim().slice(0, 500) || null },
    });
    // Tell the author about a decision on their own review (approve/reject only; hiding is not announced).
    if (next === "APPROVED" || next === "REJECTED") {
      await notifyUser(tx, {
        userId: review.userId,
        type: "REVIEW",
        title: next === "APPROVED" ? "Your review is published" : "Your review was not published",
        body: next === "APPROVED" ? `Thank you for reviewing ${review.product.name}.` : `Your review of ${review.product.name} did not meet our review guidelines.`,
        href: `/products/${review.product.slug}`,
        dedupeKey: `review:${reviewId}:${next}`,
      });
    }
  });
}

/**
 * Called when an order's status changes. Visibility itself is derived at read time; this only
 * records WHEN eligibility was revoked or restored so the history explains it.
 */
export async function recordEligibilityChange(
  tx: Prisma.TransactionClient,
  orderId: string,
  from: string,
  to: string,
) {
  const wasEligible = from === "DELIVERED";
  const isEligible = to === "DELIVERED";
  if (wasEligible === isEligible) return;
  const reviews = await tx.review.findMany({
    where: { status: "APPROVED", orderItem: { orderId } },
    select: { id: true },
  });
  for (const r of reviews) {
    await tx.reviewModerationEvent.create({
      data: {
        reviewId: r.id,
        action: isEligible ? "AUTO_REPUBLISHED" : "AUTO_UNPUBLISHED",
        actorId: null,
        note: isEligible ? "Order is delivered again" : `Order moved to ${to}`,
      },
    });
  }
}
