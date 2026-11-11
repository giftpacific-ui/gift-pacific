import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { adminGetJob, adminListApplications } from "@/server/services/career.service";
import { ApplicationList, JobForm, QuestionManager } from "@/features/admin/job-manager";

export const metadata: Metadata = { title: "Job · Careers · Admin" };

export default async function AdminJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await adminGetJob(id);
  if (!job) notFound();
  const applications = await adminListApplications(id);
  return (
    <div className="space-y-8">
      <Link href="/admin/careers" className="text-sm text-muted-foreground hover:text-foreground">← All jobs</Link>
      <h1 className="font-heading text-2xl">{job.title}</h1>
      <JobForm job={{ ...job, closesAt: job.closesAt ? job.closesAt.toISOString() : null }} />
      <section className="space-y-3">
        <h2 className="font-heading text-lg">Application questions</h2>
        <QuestionManager jobId={job.id} questions={job.questions} />
      </section>
      <section className="space-y-3">
        <h2 className="font-heading text-lg">Applications ({applications.length})</h2>
        <p className="text-xs text-muted-foreground">Applicant details are private to admins and are never shown on the website.</p>
        <ApplicationList
          jobId={job.id}
          applications={applications.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
        />
      </section>
    </div>
  );
}
