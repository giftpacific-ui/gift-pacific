"use client";

import { useMemo, useState } from "react";
import { BadgeCheck, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import type { PublicReview } from "@/lib/product-dto";

const PAGE_SIZE = 5;
type Sort = "newest" | "highest" | "lowest";

/**
 * Published reviews only (the server already filtered them). The summary is computed from exactly these rows, so the
 * average and the count can never drift from what is shown.
 */
export function ProductReviewsList({ reviews }: { reviews: PublicReview[] }) {
  const [sort, setSort] = useState<Sort>("newest");
  const [visible, setVisible] = useState(PAGE_SIZE);

  const sorted = useMemo(() => {
    const list = [...reviews];
    if (sort === "highest") list.sort((a, b) => b.rating - a.rating || +new Date(b.createdAt) - +new Date(a.createdAt));
    else if (sort === "lowest") list.sort((a, b) => a.rating - b.rating || +new Date(b.createdAt) - +new Date(a.createdAt));
    else list.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return list;
  }, [reviews, sort]);

  if (reviews.length === 0) return <p className="text-muted-foreground">No reviews yet.</p>;

  const average = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
  const counts = [5, 4, 3, 2, 1].map((star) => ({ star, count: reviews.filter((r) => r.rating === star).length }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-6 rounded-[4px] border border-border p-4">
        <div>
          <p className="font-heading text-3xl font-semibold">{average.toFixed(1)}</p>
          <p className="text-xs text-muted-foreground">{reviews.length} review{reviews.length === 1 ? "" : "s"}</p>
        </div>
        <ul className="min-w-[180px] flex-1 space-y-1 text-xs" aria-label="Rating breakdown">
          {counts.map(({ star, count }) => (
            <li key={star} className="flex items-center gap-2">
              <span className="w-8 shrink-0">{star} ★</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                <span className="block h-full bg-primary" style={{ width: `${(count / reviews.length) * 100}%` }} />
              </span>
              <span className="w-6 shrink-0 text-right text-muted-foreground">{count}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">Showing {Math.min(visible, sorted.length)} of {sorted.length}</p>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Sort by</span>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort);
              setVisible(PAGE_SIZE);
            }}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="newest">Newest</option>
            <option value="highest">Highest rated</option>
            <option value="lowest">Lowest rated</option>
          </select>
        </label>
      </div>

      {sorted.slice(0, visible).map((review, index) => (
        <div key={`${review.reviewerName}-${String(review.createdAt)}-${index}`} className="border-b border-border pb-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex gap-0.5 text-primary" role="img" aria-label={`${review.rating} out of 5 stars`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} className={`size-3.5 ${n <= review.rating ? "fill-current" : ""}`} aria-hidden />
              ))}
            </span>
            <p className="text-sm font-semibold">{review.reviewerName}</p>
            {review.verifiedPurchase && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                <BadgeCheck className="size-3.5" aria-hidden /> Verified purchase
              </span>
            )}
            <span className="text-xs text-muted-foreground">{formatDate(review.createdAt)}</span>
          </div>
          {review.title && <p className="mt-2 font-heading text-lg font-semibold">{review.title}</p>}
          {review.body && <p className="mt-1 text-sm whitespace-pre-line text-foreground/90">{review.body}</p>}
        </div>
      ))}

      {visible < sorted.length && (
        <Button type="button" variant="outline" onClick={() => setVisible((v) => v + PAGE_SIZE)}>
          Show more reviews
        </Button>
      )}
    </div>
  );
}
