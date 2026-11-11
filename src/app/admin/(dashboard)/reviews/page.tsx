import type { Metadata } from "next";
import Link from "next/link";
import { Star } from "lucide-react";
import { adminListReviews, type ReviewFilter } from "@/server/services/admin-review.service";
import { ReviewModerationButtons } from "@/features/admin/review-moderation-buttons";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Reviews · Admin" };

const FILTERS: { value: ReviewFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
    { value: "rejected", label: "Rejected" },
  { value: "hidden", label: "Hidden" },
];

export default async function AdminReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const filter: ReviewFilter = FILTERS.some((f) => f.value === sp.status) ? (sp.status as ReviewFilter) : "pending";
  const { items, total, page, pageCount } = await adminListReviews(filter, Number(sp.page) || 1);

  return (
    <div className="space-y-6">
      <h1 className="font-heading text-2xl">Reviews</h1>
      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={`/admin/reviews?status=${f.value}`}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm",
              filter === f.value ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary",
            )}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {filter} reviews.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((review) => (
            <li key={review.id} className="space-y-2 rounded-xl border border-border/70 bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <Link href={`/admin/products/${review.productId}`} className="font-medium underline">
                    {review.product.name}
                  </Link>
                  <span className="text-muted-foreground">
                    {" "}· {review.user.name} ({review.user.email}) · {formatDate(review.createdAt)}
                  </span>
                </div>
                <div className="flex" aria-label={`${review.rating} out of 5`}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Star key={n} className={cn("size-4", n <= review.rating ? "fill-primary text-primary" : "text-muted-foreground")} />
                  ))}
                </div>
              </div>
              {review.title && <p className="font-medium">{review.title}</p>}
              {/* Rendered as plain text (React escapes it); never as HTML. */}
              <p className="whitespace-pre-line text-sm">{review.body}</p>
              {review.status === "APPROVED" && !review.publiclyVisible && (
                <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Not shown publicly: order {review.orderNumber} is {review.orderStatus?.toLowerCase().replace("_", " ")}. It returns automatically if the order is delivered again.
                </p>
              )}
              <ReviewModerationButtons reviewId={review.id} status={review.status} />
              {review.events.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">History ({review.events.length})</summary>
                  <ul className="mt-1 space-y-0.5">
                    {review.events.map((e) => (
                      <li key={e.id}>{formatDate(e.createdAt)} · {e.action.toLowerCase().replaceAll("_", " ")}{e.actorId ? "" : " (automatic)"}{e.note ? ` — ${e.note}` : ""}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {total} total · page {page} of {pageCount}
      </p>
    </div>
  );
}
