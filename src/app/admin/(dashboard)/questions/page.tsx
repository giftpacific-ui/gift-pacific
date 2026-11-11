import type { Metadata } from "next";
import Link from "next/link";
import { adminListQuestions, type QuestionFilter } from "@/server/services/question.service";
import { QuestionAdminCard } from "@/features/admin/question-admin-card";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Questions · Admin" };

const FILTERS: { value: QuestionFilter; label: string }[] = [
  { value: "unanswered", label: "Unanswered" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Published" },
  { value: "hidden", label: "Hidden" },
];

export default async function AdminQuestionsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const sp = await searchParams;
  const filter: QuestionFilter = FILTERS.some((f) => f.value === sp.status) ? (sp.status as QuestionFilter) : "unanswered";
  const { items, total, page, pageCount } = await adminListQuestions(filter, Number(sp.page) || 1);

  return (
    <div className="space-y-6">
      <h1 className="font-heading text-2xl">Product questions</h1>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={`/admin/questions?status=${f.value}`}
            className={cn("rounded-full border px-4 py-1.5 text-sm", filter === f.value ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary")}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} questions.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((q) => (
            <li key={q.id}>
              <QuestionAdminCard
                question={{
                  id: q.id,
                  question: q.question,
                  answer: q.answer,
                  status: q.status,
                  createdAt: q.createdAt.toISOString(),
                  productName: q.product.name,
                  productSlug: q.product.slug,
                  askedBy: q.user.name,
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {pageCount > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          {page > 1 ? <Link className="text-primary hover:underline" href={`/admin/questions?status=${filter}&page=${page - 1}`}>← Previous</Link> : <span />}
          <span className="text-muted-foreground">Page {page} of {pageCount} · {total} total</span>
          {page < pageCount ? <Link className="text-primary hover:underline" href={`/admin/questions?status=${filter}&page=${page + 1}`}>Next →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
