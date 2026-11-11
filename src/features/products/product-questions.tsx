import { MessageCircleQuestion } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { PublicQuestion } from "@/server/services/question.service";
import { AskQuestionForm } from "@/features/products/ask-question-form";

/** Approved questions with the store's answer. Server-rendered; text is plain (React escapes it). */
export function ProductQuestions({ productId, questions }: { productId: string; questions: PublicQuestion[] }) {
  return (
    <div id="questions" className="space-y-5">
      {questions.length === 0 ? (
        <p className="text-muted-foreground">No questions yet. Be the first to ask.</p>
      ) : (
        <ul className="space-y-5">
          {questions.map((q) => (
            <li key={q.id} className="border-b border-border pb-5">
              <p className="flex items-start gap-2 font-medium">
                <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span className="whitespace-pre-line">{q.question}</span>
              </p>
              <p className="mt-1 pl-6 text-xs text-muted-foreground">Asked by {q.askedBy} · {formatDate(q.createdAt)}</p>
              {q.answer ? (
                <div className="mt-2 ml-6 rounded-[4px] bg-secondary/50 p-3 text-sm">
                  <p className="text-xs font-semibold text-primary">Answer from the store{q.answeredAt ? ` · ${formatDate(q.answeredAt)}` : ""}</p>
                  <p className="mt-1 whitespace-pre-line">{q.answer}</p>
                </div>
              ) : (
                <p className="mt-2 pl-6 text-sm text-muted-foreground">Not answered yet.</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <AskQuestionForm productId={productId} />
    </div>
  );
}
