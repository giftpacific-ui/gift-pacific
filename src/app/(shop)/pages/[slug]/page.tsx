import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/seo/json-ld";
import { CmsContent } from "@/components/layout/cms-content";
import { noIndexMetadata } from "@/lib/seo";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/structured-data";
import { cmsPageSeoOverride } from "@/lib/seo-cms";
import { getPublishedPageBySlug } from "@/server/services/static-page.service";
import { getCanonicalOrigin, pageMetadata } from "@/server/services/seo.service";

export const revalidate = 3600;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPublishedPageBySlug(slug);
  if (!page) return noIndexMetadata("Page not found");
  return pageMetadata(
    { title: page.title, description: page.html.replace(/<[^>]*>/g, " "), path: `/pages/${page.slug}` },
    { override: cmsPageSeoOverride(page) },
  );
}

export default async function CmsPage({ params }: Props) {
  const { slug } = await params;
  const page = await getPublishedPageBySlug(slug);
  if (!page) notFound();
  const origin = await getCanonicalOrigin();
  const path = `/pages/${page.slug}`;
  return (
    <div className="container-boutique py-12">
      <JsonLd
        data={[
          webPageJsonLd({ name: page.seoTitle || page.title, description: page.seoDescription, path, datePublished: page.publishedAt, dateModified: page.updatedAt, origin }),
          breadcrumbJsonLd([{ name: "Home", path: "/" }, { name: page.title, path }], origin),
        ]}
      />
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
