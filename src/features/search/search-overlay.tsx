"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useSearchUiStore } from "@/features/search/search-ui-store";
import { searchSuggestionsAction, type SearchSuggestion } from "@/server/actions/search.actions";
import { formatPrice } from "@/lib/utils";

const MIN_CHARS = 2;

/**
 * Full-screen search overlay. Typing shows live suggestions (public product
 * data only); Enter or "View all results" goes to the real results page
 * (/search?q=…), which stays the source of truth. Esc closes, focus is
 * trapped while open and restored afterwards (Radix Dialog), and "/" opens it
 * from anywhere outside a text field.
 */
export function SearchOverlay() {
  const { isOpen, open, close } = useSearchUiStore();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchSuggestion[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  // "/" shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      e.preventDefault();
      open();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Debounced suggestions; stale responses are ignored.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus("loading");
    const timer = setTimeout(() => {
      searchSuggestionsAction(q)
        .then((r) => {
          if (cancelled) return;
          setResults(r);
          setStatus("done");
        })
        .catch(() => !cancelled && setStatus("error"));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      close();
      setQuery("");
      setResults([]);
      setStatus("idle");
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    handleOpenChange(false);
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Search the shop</DialogTitle>
        <DialogDescription className="sr-only">
          Type to see matching products, press Enter to see all results, or Escape to close.
        </DialogDescription>

        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-5 pt-10 pb-6 sm:pt-16">
          <form onSubmit={submit} role="search" className="flex items-center gap-3 border-b-2 border-foreground pb-3">
            <Search className="size-6 shrink-0" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What are you looking for?"
              aria-label="Search products"
              autoComplete="off"
              maxLength={80}
              className="min-w-0 flex-1 bg-transparent font-heading text-2xl font-medium outline-none placeholder:text-muted-foreground/60 sm:text-3xl"
            />
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              aria-label="Close search"
              className="grid size-10 shrink-0 place-items-center rounded-full transition-colors hover:bg-secondary"
            >
              <X className="size-5" />
            </button>
          </form>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto" aria-live="polite">
            {status === "idle" && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Start typing a product or collection name. Tip: press <kbd className="rounded border px-1">/</kbd> anywhere to search.
              </p>
            )}
            {status === "loading" && <p className="py-6 text-center text-sm text-muted-foreground">Searching…</p>}
            {status === "error" && (
              <p className="py-6 text-center text-sm text-destructive">
                Suggestions aren&apos;t available right now — press Enter to search anyway.
              </p>
            )}
            {status === "done" && results.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing found for &ldquo;{query.trim()}&rdquo;. Try a different spelling, or press Enter to search all products.
              </p>
            )}
            {results.length > 0 && (
              <ul className="grid gap-1">
                {results.map((item) => (
                  <li key={item.slug}>
                    <Link
                      href={`/products/${item.slug}`}
                      onClick={() => handleOpenChange(false)}
                      className="flex items-center gap-4 rounded-md px-2 py-2.5 transition-colors hover:bg-secondary focus-visible:bg-secondary"
                    >
                      <span className="relative h-16 w-12 shrink-0 overflow-hidden rounded-[3px] bg-secondary">
                        {item.imageUrl && <Image src={item.imageUrl} alt="" fill sizes="48px" className="object-cover product-image-tone" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-heading text-lg font-semibold">{item.name}</span>
                        <span className="block text-sm text-muted-foreground">
                          {item.categoryName ? `${item.categoryName} · ` : ""}
                          {formatPrice(item.price)}
                          {!item.inStock && " · Out of stock"}
                        </span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </Link>
                  </li>
                ))}
                <li className="pt-2">
                  <Link
                    href={`/search?q=${encodeURIComponent(query.trim())}`}
                    onClick={() => handleOpenChange(false)}
                    className="link-underline text-sm"
                  >
                    View all results for &ldquo;{query.trim()}&rdquo; <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </li>
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
