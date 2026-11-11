import type { Metadata } from "next";
import { pageMetadata } from "@/server/services/seo.service";
import Link from "next/link";
import { notFound } from "next/navigation";
import { siteConfig } from "@/config/site";
import { getOpenJobBySlug } from "@/server/services/career.service";
import { ApplicationForm } from "@/features/career/application-form";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const job = await getOpenJobBySlug((await params).slug);
  if (!job) return { title: "Careers", robots: { index: false, follow: true } };
  return pageMetadata({ title: `${job.title} – Careers`, description: `${job.title} at ${siteConfig.name}.`, path: `/career/${job.slug}` });
}

export default async function JobPage({ params }: Props) {
  const job = await getOpenJobBySlug((await params).slug);
  if (!job) notFound();
  return (
    <div className="container-boutique mx-auto max-w-3xl space-y-10 px-4 py-16 sm:px-6">
      <Link href="/career" className="text-sm text-muted-foreground hover:text-foreground">← All positions</Link>
      <header className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold">{job.title}</h1>
        <p className="text-sm text-muted-foreground">{[job.department, job.location, job.employmentType].filter(Boolean).join(" · ")}</p>
      </header>
      {/* Plain text only (rendered as text, never as HTML). */}
      <section className="space-y-2">
        <h2 className="font-heading text-lg font-semibold">About the role</h2>
        <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{job.description}</p>
      </section>
      {job.requirements && (
        <section className="space-y-2">
          <h2 className="font-heading text-lg font-semibold">Requirements</h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{job.requirements}</p>
        </section>
      )}
      <section className="space-y-4 rounded-[4px] border border-border bg-card p-6" aria-labelledby="apply-heading">
        <h2 id="apply-heading" className="font-heading text-xl font-semibold">Apply for this position</h2>
        <ApplicationForm slug={job.slug} questions={job.questions} />
      </section>
    </div>
  );
}
