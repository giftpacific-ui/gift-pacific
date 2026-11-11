import type { Metadata } from "next";
import { listProducts } from "@/server/services/product.service";
import { ProductCard } from "@/features/products/product-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchIcon } from "lucide-react";
import { TrackSearch } from "@/features/products/track-search";

// Search result pages are thin, endless URL variations — keep them out of search engines.
export const metadata: Metadata = {
  // Search results are never indexed and carry no canonical: every query would otherwise be a thin duplicate page.
  title: "Search",
  robots: { index: false, follow: true },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const query = sp.q ?? "";

  const { items, total, page, pageCount } = query
    ? await listProducts({ search: query, page: sp.page ? Number(sp.page) : 1 })
    : { items: [], total: 0, page: 1, pageCount: 0 };

  return (
    <div className="container-boutique pt-10 pb-8 sm:pt-16">
      {query && <TrackSearch query={query} />}
      <p className="eyebrow">Search</p>
      <h1 className="mb-6 font-heading text-[clamp(2.2rem,4.5vw,3.4rem)] leading-tight font-semibold">
        {query ? <>Results for &ldquo;{query}&rdquo;</> : "Search the shop"}
      </h1>
      <form role="search" action="/search" className="relative mb-10 max-w-xl">
        <label htmlFor="search-page-q" className="sr-only">
          Search products
        </label>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input id="search-page-q" name="q" defaultValue={query} maxLength={80} placeholder="Search for gifts…" className="h-12 rounded-[3px] pr-28 pl-11" />
        <Button type="submit" variant="ink" size="sm" className="absolute top-1/2 right-1.5 -translate-y-1/2">
          Search
        </Button>
      </form>

      {!query ? (
        <EmptyState title="Search our collection" description="Type a product or category name above." />
      ) : items.length === 0 ? (
        <EmptyState
          title={`No results for "${query}"`}
          description="Try a broader search term, or browse the categories instead."
          action={
            <Button asChild variant="outline">
              <Link href="/shop">Browse the shop</Link>
            </Button>
          }
        />
      ) : (
        <>
          <p className="mb-8 text-sm text-muted-foreground" aria-live="polite">
            {total} result{total === 1 ? "" : "s"}
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 sm:gap-x-6 lg:gap-y-12 xl:grid-cols-4">
            {items.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
          <Pagination page={page} pageCount={pageCount} basePath="/search" searchParams={sp} />
        </>
      )}
    </div>
  );
}
