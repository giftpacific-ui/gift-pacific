import "server-only";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/current-user";
import { UserFacingError } from "@/lib/errors";
import { authorReviewLabel, canEditReview, publicReviewWhere, validateReview, REVIEW_ELIGIBLE_ORDER_STATUS, type ReviewInput } from "@/lib/review-rules";
import { shortReviewerName } from "@/lib/product-dto";

export type FeaturedReview = {
  rating: number;
  title: string | null;
  body: string;
  reviewerName: string;
  productName: string;
  productSlug: string;
};

/**
 * Real, admin-APPROVED customer reviews for the homepage (4–5 stars, with some
 * substance, on products that are still on sale). Explicit fields only; the
 * reviewer is shown as "First L." — never an email or full name. Returns []
 * when there are none, and the homepage then simply omits the section.
 */
export async function getFeaturedReviews(limit = 3): Promise<FeaturedReview[]> {
  const rows = await prisma.review.findMany({
    where: { ...publicReviewWhere(), rating: { gte: 4 }, product: { status: "ACTIVE" } },
    orderBy: [{ rating: "desc" }, { createdAt: "desc" }],
    take: 20,
    select: {
      rating: true,
      title: true,
      body: true,
      user: { select: { name: true } },
      product: { select: { name: true, slug: true } },
    },
  });
  return rows
    .filter((r) => (r.body ?? "").trim().length >= 20)
    .slice(0, Math.min(Math.max(limit, 1), 6))
    .map((r) => ({
      rating: r.rating,
      title: r.title,
      body: (r.body ?? "").trim().slice(0, 280),
      reviewerName: shortReviewerName(r.user.name),
      productName: r.product.name,
      productSlug: r.product.slug,
    }));
}

export type ReviewEligibility = "login_required" | "not_purchased" | "already_reviewed" | "can_review";

/**
 * The delivered order ITEM that would earn this customer a review of the product: from a
 * DELIVERED order of theirs, not yet used for a review. Null when they have none.
 */
async function findEligibleOrderItem(userId: string, productId: string) {
  const items = await prisma.orderItem.findMany({
    where: { productId, order: { userId, status: REVIEW_ELIGIBLE_ORDER_STATUS } },
    select: { id: true, order: { select: { createdAt: true } } },
  });
  if (items.length === 0) return null;
  // An order item can earn only ONE review (Review.orderItemId is unique): skip used ones.
  const used = await prisma.review.findMany({ where: { orderItemId: { in: items.map((i) => i.id) } }, select: { orderItemId: true } });
  const usedIds = new Set(used.map((r) => r.orderItemId));
  const free = items.filter((i) => !usedIds.has(i.id));
  if (free.length === 0) return null;
  return [...free].sort((a, b) => b.order.createdAt.getTime() - a.order.createdAt.getTime())[0];
}

/**
 * A customer may review a product only through an item of one of their DELIVERED orders,
 * and only once per product (Review(userId, productId) and Review.orderItemId are unique).
 */
export async function getReviewEligibility(productId: string): Promise<ReviewEligibility> {
  const session = await getSession();
  if (!session) return "login_required";
  if (typeof productId !== "string" || !productId) return "not_purchased";
  const existing = await prisma.review.findFirst({ where: { userId: session.sub, productId }, select: { id: true } });
  if (existing) return "already_reviewed";
  return (await findEligibleOrderItem(session.sub, productId)) ? "can_review" : "not_purchased";
}

export async function submitReview(productId: string, input: ReviewInput) {
  const session = await getSession();
  if (!session) throw new UserFacingError("Please sign in to write a review.");
  const valid = validateReview(input);
  if (!valid.ok) throw new UserFacingError(valid.message);
  if (typeof productId !== "string" || !productId) throw new UserFacingError("Only customers who received this product can review it.");
  const existing = await prisma.review.findFirst({ where: { userId: session.sub, productId }, select: { id: true } });
  if (existing) throw new UserFacingError("You have already reviewed this product.");
  const item = await findEligibleOrderItem(session.sub, productId);
  if (!item) throw new UserFacingError("Only customers who received this product can review it.");
  try {
    await prisma.$transaction(async (tx) => {
      const review = await tx.review.create({
        data: {
          productId,
          userId: session.sub,
          orderItemId: item.id,
          rating: valid.rating,
          title: valid.title,
          body: valid.body,
          status: "PENDING", // always starts private, pending moderation
          isApproved: false,
        },
      });
      await tx.reviewModerationEvent.create({ data: { reviewId: review.id, action: "SUBMITTED", actorId: session.sub } });
    });
  } catch (error) {
    // Two simultaneous submissions: the unique indexes let exactly one through.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      throw new UserFacingError("You have already reviewed this product.");
    }
    throw error;
  }
}

export type MyReview = {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  rating: number;
  title: string | null;
  body: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "HIDDEN";
  label: string;
  canEdit: boolean;
  createdAt: Date;
};

const mySelect = {
  id: true,
  productId: true,
  rating: true,
  title: true,
  body: true,
  status: true,
  createdAt: true,
  product: { select: { name: true, slug: true } },
  orderItem: { select: { order: { select: { status: true } } } },
} as const;

type MyRow = {
  id: string; productId: string; rating: number; title: string | null; body: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "HIDDEN"; createdAt: Date;
  product: { name: string; slug: string }; orderItem: { order: { status: string } } | null;
};

const toMine = (r: MyRow): MyReview => ({
  id: r.id,
  productId: r.productId,
  productName: r.product.name,
  productSlug: r.product.slug,
  rating: r.rating,
  title: r.title,
  body: r.body,
  status: r.status,
  label: authorReviewLabel({ status: r.status, orderStatus: r.orderItem?.order.status ?? null }),
  canEdit: canEditReview(r.status, r.orderItem?.order.status ?? null),
  createdAt: r.createdAt,
});

/** The signed-in author's own reviews — every status, including unapproved and hidden. Only theirs. */
export async function getMyReviews(): Promise<MyReview[]> {
  const session = await getSession();
  if (!session) return [];
  const rows = await prisma.review.findMany({ where: { userId: session.sub }, orderBy: { createdAt: "desc" }, select: mySelect });
  return rows.map((r) => toMine(r as MyRow));
}

export async function getMyReviewForProduct(productId: string): Promise<MyReview | null> {
  const session = await getSession();
  if (!session || typeof productId !== "string") return null;
  const row = await prisma.review.findFirst({ where: { userId: session.sub, productId }, select: mySelect });
  return row ? toMine(row as MyRow) : null;
}

/**
 * Edit the signed-in customer's own review. An edited review goes back to PENDING (it is unpublished until the store
 * approves the new text), and the change is recorded in the moderation history. Only the author, only while editable.
 */
export async function updateMyReview(productId: string, input: ReviewInput) {
  const session = await getSession();
  if (!session) throw new UserFacingError("Please sign in to edit your review.");
  const valid = validateReview(input);
  if (!valid.ok) throw new UserFacingError(valid.message);
  if (typeof productId !== "string" || !productId) throw new UserFacingError("Review not found.");
  const review = await prisma.review.findFirst({
    where: { userId: session.sub, productId },
    select: { id: true, status: true, orderItem: { select: { order: { select: { status: true } } } } },
  });
  if (!review) throw new UserFacingError("You have not reviewed this product.");
  if (!canEditReview(review.status, review.orderItem?.order.status ?? null)) throw new UserFacingError("This review can no longer be edited.");
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.review.updateMany({
      where: { id: review.id, userId: session.sub, status: review.status },
      data: { rating: valid.rating, title: valid.title, body: valid.body, status: "PENDING", isApproved: false, rejectedAt: null },
    });
    if (claimed.count !== 1) throw new UserFacingError("This review was just changed. Reload and try again.");
    await tx.reviewModerationEvent.create({
      data: { reviewId: review.id, action: "EDITED", actorId: session.sub, note: review.status === "APPROVED" ? "Edited after approval; back in moderation" : null },
    });
  });
}
