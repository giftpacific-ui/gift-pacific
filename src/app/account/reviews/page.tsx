import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { getMyReviews } from "@/server/services/review.service";

export const metadata: Metadata = { title: "My reviews" };

export default async function MyReviewsPage() {
  const reviews = await getMyReviews();
  return (
    <div className="space-y-6">
      <h1 className="font-heading text-2xl">My reviews</h1>
      {reviews.length === 0 ? (
        <EmptyState title="No reviews yet" description="You can review products from your delivered orders." />
      ) : (
        <ul className="space-y-4">
          {reviews.map((r) => (
            <li key={r.id} className="space-y-1 rounded-lg border border-border p-4 text-sm">
              <Link href={`/products/${r.productSlug}`} className="font-medium underline">{r.productName}</Link>
              <p aria-label={`${r.rating} out of 5`}>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</p>
              {r.title && <p className="font-medium">{r.title}</p>}
              <p className="whitespace-pre-line text-muted-foreground">{r.body}</p>
              <p className="text-xs text-muted-foreground">{r.label}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
