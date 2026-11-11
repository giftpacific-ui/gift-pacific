import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** 1 … 4 5 6 … 12 — always includes the first, last and current±1 pages. */
export function pageWindow(page: number, pageCount: number): (number | "gap")[] {
  const wanted = new Set([1, pageCount, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pageCount));
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

export function Pagination({
  page,
  pageCount,
  basePath,
  searchParams,
}: {
  page: number;
  pageCount: number;
  basePath: string;
  searchParams: Record<string, string | undefined>;
}) {
  if (pageCount <= 1) return null;

  function hrefFor(targetPage: number) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value && key !== "page") params.set(key, value);
    }
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  const base = "grid size-10 place-items-center rounded-[3px] border text-sm font-medium transition-colors";
  const edge = (disabled: boolean) =>
    cn(base, "border-border", disabled ? "pointer-events-none opacity-40" : "hover:border-foreground");

  return (
    <nav className="mt-14 flex items-center justify-center gap-1.5" aria-label="Pagination">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} className={edge(false)} aria-label="Previous page" rel="prev">
          <ChevronLeft className="size-4" />
        </Link>
      ) : (
        <span className={edge(true)} aria-hidden>
          <ChevronLeft className="size-4" />
        </span>
      )}

      {pageWindow(page, pageCount).map((p, i) =>
        p === "gap" ? (
          <span key={`gap-${i}`} className="grid size-10 place-items-center text-muted-foreground" aria-hidden>
            …
          </span>
        ) : (
          <Link
            key={p}
            href={hrefFor(p)}
            aria-label={`Page ${p}`}
            aria-current={p === page ? "page" : undefined}
            className={cn(base, p === page ? "border-foreground bg-foreground text-background" : "border-transparent hover:border-border")}
          >
            {p}
          </Link>
        ),
      )}

      {page < pageCount ? (
        <Link href={hrefFor(page + 1)} className={edge(false)} aria-label="Next page" rel="next">
          <ChevronRight className="size-4" />
        </Link>
      ) : (
        <span className={edge(true)} aria-hidden>
          <ChevronRight className="size-4" />
        </span>
      )}
    </nav>
  );
}
