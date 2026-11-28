import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminListEmailJobs } from "@/server/services/admin-email-queue.service";
import { QueueJobsTable } from "@/features/admin/email-queue/queue-jobs-table";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Send queue · Email marketing · Admin" };
// The Retry button on this page is a server action: it runs inside this page's function, so the Hobby limit declared here is the one that bounds it.
// (Must be a literal for Next.js; keep it equal to the request budget in src/lib/email/queue-policy.ts.)
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BASE = "/admin/email-marketing/queue";

export default async function EmailQueuePage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const res = await adminListEmailJobs(admin.id, { status: sp.status, page: sp.page });
  if (!res.ok) return <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{res.message}</p>;
  const tabs = [{ key: "PENDING", label: "Pending", n: res.counts.pending }, { key: "FAILED", label: "Failed", n: res.counts.failed }] as const;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Send queue</h1>
        <p className="text-sm text-muted-foreground">
          E-mails wait here until you send them. Nothing in this system sends, retries or polls the queue by itself: select e-mails and click Retry, and a limited batch is sent while the page waits.
          E-mails that are not reached stay exactly as they are, ready for another click. Sent e-mails never appear here and can never be re-sent.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by status">
        {tabs.map((t) => (
          <Link key={t.key} href={`${BASE}?status=${t.key}`} className={cn("rounded-full border px-3 py-1 text-sm", res.filter === t.key ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary")}>
            {t.label} ({t.n.toLocaleString("en-US")})
          </Link>
        ))}
      </div>
      <QueueJobsTable key={`${res.filter}-${res.page}`} rows={res.rows} selectionLimit={res.selectionLimit} batchLimit={res.batchLimit} />
      {res.pageCount > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
          {res.page > 1 ? <Link className="text-primary hover:underline" href={`${BASE}?status=${res.filter}&page=${res.page - 1}`}>← Previous</Link> : <span />}
          <span className="text-muted-foreground">Page {res.page} of {res.pageCount} · {res.total} e-mails</span>
          {res.page < res.pageCount ? <Link className="text-primary hover:underline" href={`${BASE}?status=${res.filter}&page=${res.page + 1}`}>Next →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
