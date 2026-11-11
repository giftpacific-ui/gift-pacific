"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { askQuestionAction } from "@/server/actions/question.actions";
import { getReviewEligibilityAction } from "@/server/actions/review.actions";
import { QUESTION_MAX, QUESTION_MIN } from "@/lib/question-rules";
import { useEffect } from "react";

/**
 * Signed-in customers only. Session state is read on the client (like the review form) so the product page itself
 * stays free of per-user cookies. The server action re-checks the session; the question is private until approved.
 */
export function AskQuestionForm({ productId }: { productId: string }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    // Reuses the existing eligibility call purely to learn whether a session exists (no product data involved).
    getReviewEligibilityAction(productId)
      .then((r) => !cancelled && setSignedIn(r !== "login_required"))
      .catch(() => !cancelled && setSignedIn(false));
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (signedIn === null) return null;
  if (!signedIn) {
    return (
      <p className="text-sm text-muted-foreground">
        <Link href={`/login?redirect=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/")}`} className="link-underline">Sign in</Link> to ask a question about this product.
      </p>
    );
  }
  if (sent) {
    return <p role="status" className="rounded-[4px] border border-border p-4 text-sm">Thank you! Your question was sent. It will appear here once the store has replied.</p>;
  }

  return (
    <div className="space-y-3 rounded-[4px] border border-border p-5">
      <h3 className="font-heading text-lg">Ask a question</h3>
      <label className="sr-only" htmlFor="product-question">Your question</label>
      <Textarea
        id="product-question"
        rows={3}
        value={text}
        maxLength={QUESTION_MAX}
        placeholder="What would you like to know about this product?"
        onChange={(e) => setText(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">Please don&apos;t include phone numbers or addresses. Questions are public once answered.</p>
      <Button
        type="button"
        disabled={pending || text.trim().length < QUESTION_MIN}
        onClick={() =>
          startTransition(async () => {
            const result = await askQuestionAction(productId, text);
            if (!result.success) {
              toast.error(result.message);
              return;
            }
            setSent(true);
          })
        }
      >
        {pending ? "Sending…" : "Send question"}
      </Button>
    </div>
  );
}
