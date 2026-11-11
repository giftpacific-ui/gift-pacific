import type { ReactNode } from "react";

/** Shared shell for the Terms and Privacy pages. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="container-boutique py-12">
      <article className="mx-auto max-w-2xl space-y-6 text-sm leading-relaxed text-muted-foreground [&_h2]:mt-8 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:text-foreground [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
        <h1 className="font-heading text-[clamp(2rem,4.5vw,3rem)] font-semibold leading-tight text-foreground">{title}</h1>
        <p className="text-xs">Last updated {updated}</p>
        {children}
      </article>
    </div>
  );
}
