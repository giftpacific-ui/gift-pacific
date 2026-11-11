import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  getActiveCampaign,
  getCampaignProducts,
} from "@/server/services/campaign.service";
import { ProductCard } from "@/features/products/product-card";
import { Pagination } from "@/components/shared/pagination";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { firstText, noIndexMetadata } from "@/lib/seo";
import { pageMetadata } from "@/server/services/seo.service";
import { breadcrumbJsonLd, collectionPageJsonLd } from "@/lib/structured-data";
import { JsonLd } from "@/components/seo/json-ld";
import { formatDate } from "@/lib/utils";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}): Promise<Metadata> {
  const campaign = await getActiveCampaign();
  if (!campaign) {
    // Nothing is running: keep the empty page out of search results.
    return noIndexMetadata("Campaign");
  }
  const { page } = await searchParams;
  const pageNo = Number.parseInt(page ?? "1", 10);
  const paged = Number.isInteger(pageNo) && pageNo > 1;
  const customTitle = firstText(campaign.metaTitle);
  return pageMetadata({
    title: `${customTitle || campaign.name}${paged ? ` – Page ${pageNo}` : ""}`,
    titleIsCustom: !!customTitle,
    description:
      firstText(campaign.metaDescription, campaign.description) ||
      `${campaign.name} — limited-time picks from ${siteConfig.name}.`,
    // Each real page of the campaign has its own canonical; they are not collapsed onto page one.
    path: paged ? `/campaign?page=${pageNo}` : "/campaign",
    image: campaign.image,
    imageAlt: campaign.name,
  });
}

export default async function CampaignPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const sp = await searchParams;
  const campaign = await getActiveCampaign();

  if (!campaign) {
    return (
      <div className="container-boutique py-28 text-center">
        <p className="eyebrow justify-center">Campaign</p>
        <h1 className="font-heading text-4xl font-semibold">
          No campaign right now
        </h1>
        <p className="mt-3 text-muted-foreground">
          We&apos;re between campaigns — have a look around the shop in the
          meantime.
        </p>
        <Button asChild variant="ink" className="mt-6">
          <Link href="/shop">Browse the shop</Link>
        </Button>
      </div>
    );
  }

  const { items, page, pageCount } = await getCampaignProducts(
    campaign.id,
    Number(sp.page) || 1,
  );

  return (
    <div className="container-boutique pt-6 pb-8 sm:pt-10">
      <JsonLd
        data={[
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: campaign.name, path: "/campaign" },
          ]),
          collectionPageJsonLd({
            name: campaign.name,
            description: campaign.description,
            path: "/campaign",
            items: items.map((p) => ({
              name: p.name,
              path: `/products/${p.slug}`,
            })),
          }),
        ]}
      />
      <header className="relative mb-10 overflow-hidden rounded-[4px] bg-secondary">
        {campaign.image && (
          <Image
            src={campaign?.image || ""}
            alt=""
            fill
            sizes="100vw"
            priority
            className="object-cover"
          />
        )}
        <div
          className={
            campaign.image
              ? "relative bg-black/45 px-6 py-14 text-white sm:px-14"
              : "relative px-6 py-14 sm:px-14"
          }
        >
          <p className="eyebrow !text-current">Campaign</p>
          <h1 className="font-heading text-[clamp(2.2rem,5vw,3.8rem)] leading-tight font-semibold">
            {campaign.name}
          </h1>
          {campaign.description && (
            <p className="mt-3 max-w-xl text-balance">{campaign.description}</p>
          )}
          {campaign.endsAt && (
            <p className="mt-3 text-sm opacity-90">
              Ends {formatDate(campaign.endsAt)}
            </p>
          )}
        </div>
      </header>

      {items.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground">
          Products for this campaign are coming soon.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 lg:grid-cols-4 lg:gap-y-12">
          {items.map((product, i) => (
            <ProductCard key={product.id} product={product} priority={i < 4} />
          ))}
        </div>
      )}
      <Pagination
        page={page}
        pageCount={pageCount}
        basePath="/campaign"
        searchParams={sp}
      />
    </div>
  );
}
