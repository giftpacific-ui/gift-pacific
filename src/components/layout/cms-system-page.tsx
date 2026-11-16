import { CmsContent } from "@/components/layout/cms-content";
import type { PublicStaticPage } from "@/server/services/static-page.service";

/** Body for a built-in route (about-us, privacy, terms, shipping-returns) once an admin has published replacement content. */
export function CmsSystemPage({ page }: { page: PublicStaticPage }) {
  return (
    <div className="container-boutique py-12">
      <article className="mx-auto max-w-2xl space-y-6">
        <h1 className="font-heading text-[clamp(2rem,4.5vw,3rem)] leading-tight font-semibold text-foreground">{page.title}</h1>
        <CmsContent
          html={page.html}
          className="space-y-4 text-sm leading-relaxed text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mt-8 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:text-foreground [&_h3]:mt-6 [&_h3]:font-heading [&_h3]:text-lg [&_h3]:text-foreground [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5"
        />
      </article>
    </div>
  );
}
