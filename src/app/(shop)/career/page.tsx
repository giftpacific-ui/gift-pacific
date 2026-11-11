import type { Metadata } from "next";
import { pageMetadata } from "@/server/services/seo.service";
import Link from "next/link";
import { siteConfig } from "@/config/site";
import { listOpenJobs } from "@/server/services/career.service";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({ title: "Careers", description: `Open positions at ${siteConfig.name}.`, path: "/career" });
}

export default async function CareerPage() {
  const jobs = await listOpenJobs();
  return (
    <div className="container-boutique space-y-10 px-4 py-16 sm:px-6">
      <header className="mx-auto max-w-2xl space-y-3 text-center">
        <h1 className="font-heading text-[clamp(2.2rem,4.5vw,3.4rem)] font-semibold leading-tight">Careers</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Join the team behind {siteConfig.name}. Here are the positions we are hiring for right now.
        </p>
      </header>
      {jobs.length === 0 ? (
        <p className="mx-auto max-w-xl rounded-[4px] border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          There are no open positions at the moment. Please check back soon.
        </p>
      ) : (
        <ul className="mx-auto grid max-w-3xl gap-4">
          {jobs.map((job) => (
            <li key={job.slug}>
              <Link href={`/career/${job.slug}`} className="block rounded-[4px] border border-border bg-card p-6 transition-colors hover:border-foreground">
                <h2 className="font-heading text-xl font-semibold">{job.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {[job.department, job.location, job.employmentType].filter(Boolean).join(" · ")}
                </p>
                {job.closesAt && (
                  <p className="mt-2 text-xs text-muted-foreground">Apply by {job.closesAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
