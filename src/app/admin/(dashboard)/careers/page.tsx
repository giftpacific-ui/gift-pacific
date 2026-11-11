import type { Metadata } from "next";
import Link from "next/link";
import { adminListJobs } from "@/server/services/career.service";
import { JobForm } from "@/features/admin/job-manager";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Careers · Admin" };

export default async function AdminCareersPage() {
  const jobs = await adminListJobs();
  return (
    <div className="space-y-8">
      <h1 className="font-heading text-2xl">Careers</h1>
      <section className="space-y-3">
        <h2 className="font-heading text-lg">Job posts</h2>
        {jobs.length === 0 && <p className="text-sm text-muted-foreground">No jobs yet.</p>}
        {jobs.map((job) => (
          <Link key={job.id} href={`/admin/careers/${job.id}`} className="flex items-center justify-between rounded-xl border border-border/70 bg-card p-4 hover:border-foreground">
            <span className="font-medium">{job.title}</span>
            <span className="flex items-center gap-3 text-sm text-muted-foreground">
              {job._count.applications} application{job._count.applications === 1 ? "" : "s"}
              <Badge variant={job.status === "PUBLISHED" ? "success" : "secondary"}>{job.status.toLowerCase()}</Badge>
            </span>
          </Link>
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="font-heading text-lg">New job</h2>
        <JobForm job={null} />
      </section>
    </div>
  );
}
