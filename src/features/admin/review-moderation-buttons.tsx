"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { moderateReviewAction } from "@/server/actions/admin-review.actions";
import type { ModerationDecision } from "@/lib/review-rules";

const DONE: Record<ModerationDecision, string> = {
  approve: "Review approved",
  reject: "Review rejected",
  hide: "Review hidden from the public (the author can still see it)",
  unhide: "Review published again",
};

export function ReviewModerationButtons({
  reviewId,
  status,
}: {
  reviewId: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "HIDDEN";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function run(decision: ModerationDecision) {
    startTransition(async () => {
      const result = await moderateReviewAction(reviewId, decision);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(DONE[decision]);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      {(status === "PENDING" || status === "REJECTED") && (
        <Button size="sm" disabled={isPending} onClick={() => run("approve")}>Approve</Button>
      )}
      {status === "HIDDEN" && (
        <Button size="sm" disabled={isPending} onClick={() => run("unhide")}>Publish again</Button>
      )}
      {status === "APPROVED" && (
        <Button size="sm" variant="outline" disabled={isPending} onClick={() => run("hide")}>Hide from public</Button>
      )}
      {status !== "REJECTED" && (
        <Button size="sm" variant="outline" disabled={isPending} onClick={() => run("reject")}>Reject</Button>
      )}
    </div>
  );
}
