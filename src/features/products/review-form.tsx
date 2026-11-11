"use client";

import { useEffect, useState, useTransition } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  getMyReviewAction,
  getReviewEligibilityAction,
  submitReviewAction,
  updateMyReviewAction,
} from "@/server/actions/review.actions";
import type { MyReview } from "@/server/services/review.service";
import { REVIEW_BODY_MAX, REVIEW_TITLE_MAX } from "@/lib/review-rules";

/**
 * Loads eligibility on the client (not during page render) so the product
 * page itself stays free of per-user cookies and remains cacheable.
 */
export function ReviewForm({ productId }: { productId: string }) {
  const [state, setState] = useState<
    | "loading"
    | "login_required"
    | "not_purchased"
    | "already_reviewed"
    | "can_review"
    | "submitted"
  >("loading");
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
    const [isPending, startTransition] = useTransition();
  const [mine, setMine] = useState<MyReview | null>(null);
  const [editing, setEditing] = useState(false);

  // The author always sees their own review, whatever its moderation status.
  useEffect(() => {
    if (state !== "already_reviewed" && state !== "submitted") return;
    let cancelled = false;
    getMyReviewAction(productId).then((r) => !cancelled && setMine(r)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state, productId]);

  useEffect(() => {
    let cancelled = false;
    getReviewEligibilityAction(productId)
      .then((result) => !cancelled && setState(result))
      .catch(() => !cancelled && setState("not_purchased"));
    return () => {
      cancelled = true;
    };
  }, [productId]);

  function submit() {
    startTransition(async () => {
      const payload = { rating, title, body };
      const result = editing ? await updateMyReviewAction(productId, payload) : await submitReviewAction(productId, payload);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      if (editing) {
        setEditing(false);
        toast.success("Review updated. It will appear again once the store approves it.");
        getMyReviewAction(productId).then(setMine).catch(() => {});
        return;
      }
      setState("submitted");
    });
  }

  function startEditing() {
    if (!mine) return;
    setRating(mine.rating);
    setTitle(mine.title ?? "");
    setBody(mine.body ?? "");
    setEditing(true);
  }

  if (state === "loading" || state === "not_purchased") return null;
  if (state === "login_required") return null;
  if ((state === "already_reviewed" || state === "submitted") && !editing) {
    return (
      <section aria-label="Your review" className="mt-6 space-y-2 rounded-[4px] border border-border p-5 text-sm">
        <p className="font-medium">
          {state === "submitted" && !mine
            ? "Thank you! Your review is private until the store approves it."
            : "Your review"}
        </p>
        {mine && (
          <>
            <p aria-label={`${mine.rating} out of 5 stars`}>{"★".repeat(mine.rating)}{"☆".repeat(5 - mine.rating)}</p>
            {mine.title && <p className="font-medium">{mine.title}</p>}
            {/* plain text: React escapes it */}
            <p className="whitespace-pre-line text-muted-foreground">{mine.body}</p>
            <p role="status" className="text-xs text-muted-foreground">{mine.label}</p>
            {mine.canEdit && (
              <Button type="button" variant="outline" size="sm" onClick={startEditing}>
                Edit review
              </Button>
            )}
          </>
        )}
      </section>
    );
  }

  return (
    <div className="mt-8 space-y-3 rounded-[4px] border border-border p-5">
      <h3 className="font-heading text-lg">{editing ? "Edit your review" : "Write a review"}</h3>
      {editing && <p className="text-xs text-muted-foreground">After you save, your review is checked again before it is shown publicly.</p>}
      <div className="flex gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={rating === value}
            aria-label={`${value} star${value > 1 ? "s" : ""}`}
            onClick={() => setRating(value)}
            className="p-0.5"
          >
            <Star
              className={`size-6 ${
                value <= rating
                  ? "fill-primary text-primary"
                  : "text-muted-foreground"
              }`}
            />
          </button>
        ))}
      </div>
      <Input
        placeholder="Title (optional)"
        value={title}
        maxLength={REVIEW_TITLE_MAX}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        placeholder="What did you think of it?"
        value={body}
        maxLength={REVIEW_BODY_MAX}
        rows={4}
        onChange={(e) => setBody(e.target.value)}
      />
      <Button
        onClick={submit}
        disabled={isPending || rating === 0 || body.trim().length < 10}
      >
        {isPending ? "Saving…" : editing ? "Save changes" : "Submit review"}
      </Button>
      {editing && (
        <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={isPending} className="ml-2">
          Cancel
        </Button>
      )}
    </div>
  );
}
