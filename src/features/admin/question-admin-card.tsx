"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/utils";
import { ANSWER_MAX } from "@/lib/question-rules";
import { answerQuestionAction, deleteQuestionAction, setQuestionStatusAction } from "@/server/actions/question.actions";

type QuestionView = {
  id: string;
  question: string;
  answer: string | null;
  status: "PENDING" | "APPROVED" | "HIDDEN";
  createdAt: string;
  productName: string;
  productSlug: string;
  askedBy: string;
};

export function QuestionAdminCard({ question }: { question: QuestionView }) {
  const router = useRouter();
  const [answer, setAnswer] = useState(question.answer ?? "");
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ success: true } | { success: false; message: string }>, ok: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.success) return void toast.error(result.message);
      toast.success(ok);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link href={`/products/${question.productSlug}`} className="font-medium text-primary hover:underline" target="_blank">{question.productName}</Link>
        <div className="flex items-center gap-2">
          <Badge variant={question.status === "APPROVED" ? "default" : "secondary"}>{question.status === "APPROVED" ? "Published" : question.status === "PENDING" ? "Pending" : "Hidden"}</Badge>
          <span className="text-xs text-muted-foreground">{question.askedBy} · {formatDate(question.createdAt)}</span>
        </div>
      </div>
      <p className="whitespace-pre-line text-sm">{question.question}</p>
      <label className="sr-only" htmlFor={`answer-${question.id}`}>Answer</label>
      <Textarea id={`answer-${question.id}`} rows={3} maxLength={ANSWER_MAX} value={answer} placeholder="Write the store's answer…" onChange={(e) => setAnswer(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={pending || answer.trim().length < 2} onClick={() => run(() => answerQuestionAction(question.id, answer), "Answer saved and published")}>
          {question.answer ? "Update answer" : "Answer & publish"}
        </Button>
        {question.status !== "APPROVED" && question.answer && (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => setQuestionStatusAction(question.id, "APPROVED"), "Published")}>Approve</Button>
        )}
        {question.status !== "HIDDEN" && (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => setQuestionStatusAction(question.id, "HIDDEN"), "Hidden")}>Hide</Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={pending}
          onClick={() => {
            if (window.confirm("Delete this question permanently?")) run(() => deleteQuestionAction(question.id), "Deleted");
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}
