/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable react-hooks/static-components */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { categoryPath, firstText, noIndexMetadata } from "@/lib/seo";
import { pageMetadata } from "@/server/services/seo.service";
import { resolveCategoryRedirect } from "@/server/services/slug-redirect.service";
import { breadcrumbJsonLd, collectionPageJsonLd } from "@/lib/structured-data";
import { JsonLd } from "@/components/seo/json-ld";
import { keywordsForMetadata } from "@/lib/seo-keywords";
import { shopSeo } from "@/lib/seo-shop";
import { siteConfig } from "@/config/site";
import {
  getFilterableAttributes,
  resolveAttributeWhere,
} from "@/server/services/attribute.service";
import { AttributeFilters } from "@/features/products/attribute-filters";
import {
  listProducts,
  getAllCategories,
  getCategoryTree,
} from "@/server/services/product.service";
import { ShopFilterSidebar } from "@/features/products/shop-filter-sidebar";
import { ShopResultsGrid } from "@/features/products/shop-results-grid";
import { ProductFilters } from "@/features/products/product-filters";
import { Pagination } from "@/components/shared/pagination";
import { EmptyState } from "@/components/shared/empty-state";
import { MobileFilters } from "@/features/products/mobile-filters";
import { Button } from "@/components/ui/button";

type SearchParams = Record<string, string | undefined>;

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ category?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { category } = await params;
  const query = await searchParams;
  const categorySlug = category?.[0];
  const categories = categorySlug ? await getAllCategories() : [];
  const match = categorySlug
    ? categories.find((c) => c.slug === categorySlug)
    : undefined;
  if (categorySlug && !match) return noIndexMetadata("Category not found");

  // Canonical + index rules (pure, shared): filters/sort/search are noindex and point at the clean listing; real
  // pagination keeps its own canonical (?page=N) instead of collapsing onto page one.
  const seo = shopSeo({
    siteUrl: siteConfig.url,
    path: match ? [match.slug] : [],
    query,
    categoryFound: true,
  });
  const pageRaw = Array.isArray(query.page) ? query.page[0] : query.page;
  const pageNo = Number.parseInt(pageRaw ?? "1", 10);
  const pageSuffix =
    Number.isInteger(pageNo) && pageNo > 1 && seo.canonical.includes("?page=")
      ? ` – Page ${pageNo}`
      : "";

  const customTitle = firstText(match?.metaTitle);
  const base = await pageMetadata({
    title: `${customTitle || match?.name || "Shop all gifts"}${pageSuffix}`,
    titleIsCustom: !!customTitle,
    description:
      firstText(match?.metaDescription, match?.description) || undefined,
    path: match ? categoryPath(match.slug) : "/shop",
    image: match?.image,
    imageAlt: match?.name,
    keywords: keywordsForMetadata(match?.metaKeywords),
    noindex: !seo.robots.index || !!match?.seoNoIndex,
  });
  return {
    ...base,
    alternates: { canonical: seo.canonical },
    openGraph: { ...base.openGraph, url: seo.canonical },
  };
}

const PRODUCT_TYPES = {
  BUNDLE: "Gift boxes & bundles",
  PERSONALIZED: "Personalized gifts",
  VARIANT: "With options",
  STANDARD: "Ready to ship",
} as const;
type ProductTypeParam = keyof typeof PRODUCT_TYPES;
const isProductType = (v: string | undefined): v is ProductTypeParam =>
  !!v && v in PRODUCT_TYPES;

export default async function ShopPage({
  params,
  searchParams,
}: {
  params: Promise<{ category?: string[] }>;
  searchParams: Promise<SearchParams>;
}) {
  const { category } = await params;
  const sp = await searchParams;
  const categorySlug = category?.[0];
  const badges = (sp.badges ?? "")
    .split(",")
    .filter(
      (b): b is "NEW" | "BEST_SELLER" => b === "NEW" || b === "BEST_SELLER",
    );
  const type = isProductType(sp.type) ? sp.type : undefined;
  const attributeDefs = await getFilterableAttributes();
  const attributeWhere = await resolveAttributeWhere(sp);
  const kind =
    sp.kind === "combo" ? "COMBO" : sp.kind === "single" ? "SINGLE" : undefined;

  const [{ items, total, page, pageCount }, categories, categoryTree] =
    await Promise.all([
      listProducts({
        categorySlug,
        search: sp.q,
        sort:
          (sp.sort as "newest" | "price-asc" | "price-desc" | "best-selling") ??
          "newest",
        inStockOnly: sp.inStock === "true",
        isFeatured: sp.featured === "true",
        badges: badges.length > 0 ? badges : undefined,
        type,
        kind,
        attributeWhere,
        minPrice: sp.minPrice ? Number(sp.minPrice) : undefined,
        maxPrice: sp.maxPrice ? Number(sp.maxPrice) : undefined,
        page: sp.page ? Number(sp.page) : 1,
      }),
      getAllCategories(),
      getCategoryTree(),
    ]);

  const activeCategory = categories.find((c) => c.slug === categorySlug);
  if (categorySlug && !activeCategory) {
    // Renamed category → permanent redirect to its current URL; unknown/inactive → real 404 (not an empty listing).
    const current = await resolveCategoryRedirect(categorySlug);
    if (current) permanentRedirect(categoryPath(current));
    notFound();
  }
  const basePath = categorySlug ? `/shop/${categorySlug}` : "/shop";
  const roots = categoryTree.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
  }));
  const activeRootSlug =
    roots.find((r) => r.slug === categorySlug)?.slug ??
    categoryTree.find((r) =>
      JSON.stringify(r.children).includes(`"slug":"${categorySlug}"`),
    )?.slug;

  const kindHref = (value: "combo" | "single" | null) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp))
      if (v && k !== "kind" && k !== "page") params.set(k, v);
    if (value) params.set("kind", value);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const kindTabs = [
    { label: "All", value: null, active: !kind },
    { label: "Combo", value: "combo" as const, active: kind === "COMBO" },
    { label: "Single", value: "single" as const, active: kind === "SINGLE" },
  ];

  const chip =
    "whitespace-nowrap rounded-full border px-4 py-1.5 text-sm font-medium transition-colors";

  // Shared filter contents for both Desktop Sidebar and Mobile Sheet Drawer
  const FilterContents = () => (
    <div className="space-y-6">
      {/* Product Type (All, Combo, Single) inside Drawer/Sidebar */}
      <div className="space-y-3 pt-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Type
        </h3>
        <div className="flex flex-col gap-1">
          {kindTabs.map((tab) => (
            <Link
              key={tab.label}
              href={kindHref(tab.value)}
              className={`px-3 py-2 rounded-lg text-sm transition-colors ${tab.active ? "bg-foreground text-background font-medium" : "hover:bg-muted text-foreground"}`}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </div>

      {/* Additional Filters & Attributes */}
      <div className="pt-4 border-t border-border space-y-6">
        <ShopFilterSidebar
          categoryTree={categoryTree}
          activeCategorySlug={categorySlug}
        />
        <AttributeFilters
          defs={attributeDefs}
          params={sp}
          basePath={basePath}
        />
      </div>
    </div>
  );

  const listTitle = activeCategory?.name ?? "Shop all gifts";
  const structuredData = [
    breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Shop", path: "/shop" },
      ...(activeCategory
        ? [
            {
              name: activeCategory.name,
              path: categoryPath(activeCategory.slug),
            },
          ]
        : []),
    ]),
    // Only the clean, unfiltered listing is described as a collection.
    ...(Object.keys(sp).every((k) => k === "page")
      ? [
          collectionPageJsonLd({
            name: listTitle,
            description:
              firstText(
                activeCategory?.metaDescription,
                activeCategory?.description,
              ) || null,
            path: activeCategory ? categoryPath(activeCategory.slug) : "/shop",
            items: items.map((p) => ({
              name: p.name,
              path: `/products/${p.slug}`,
            })),
          }),
        ]
      : []),
  ];

  return (
    <div className="container mx-auto px-3 pt-4 pb-12">
      <JsonLd data={structuredData} />
      {activeCategory && (
        <nav
          aria-label="Breadcrumb"
          className="mt-4 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link href="/" className="hover:text-primary">
            Home
          </Link>
          <span aria-hidden>/</span>
          <Link href="/shop" className="hover:text-primary">
            Shop
          </Link>
          <span aria-hidden>/</span>
          <span className="text-foreground" aria-current="page">
            {activeCategory.name}
          </span>
        </nav>
      )}
      <header className="my-4 flex flex-wrap items-center justify-end gap-4 lg:hidden">
        {/* Mobile Filter Button triggering Sheet Drawer */}
        <div className="block lg:hidden">
          <MobileFilters>
            <FilterContents />
          </MobileFilters>
        </div>
      </header>

      <div className="flex flex-col gap-8 lg:flex-row lg:gap-12">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:block lg:w-64 shrink-0 space-y-8">
          <FilterContents />
        </aside>

        <div className="min-w-0 flex-1">
          <ProductFilters total={total} />

          {items.length === 0 ? (
            <EmptyState
              title="No products found"
              description="Try different filters, or check back soon — new pieces are added often."
              action={
                <Button asChild variant="outline">
                  <Link href="/shop">Clear all filters</Link>
                </Button>
              }
            />
          ) : (
            <ShopResultsGrid items={items} />
          )}

          <Pagination
            page={page}
            pageCount={pageCount}
            basePath={basePath}
            searchParams={sp}
          />
        </div>
      </div>
    </div>
  );
}
