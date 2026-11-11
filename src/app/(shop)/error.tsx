"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the storefront. Shows a calm message (never the raw
 * error). The server already logged the failure as a structured line
 * (instrumentation.ts → onRequestError); `digest` lets an operator match this
 * page to that log line.
 */
export default function ShopError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Client-side visibility for browser-originated errors (the server logs its own).
    console.error("[storefront-error]", error.digest ?? "no-digest");
  }, [error]);

  return (
    <div className="container-boutique grid min-h-[50vh] place-items-center py-20 text-center">
      <div className="max-w-md">
        <p className="eyebrow justify-center">Something went wrong</p>
        <h1 className="font-heading text-4xl leading-tight font-semibold">We couldn&apos;t load this page</h1>
        <p className="mt-3 text-muted-foreground">
          It&apos;s us, not you. Please try again — and if it keeps happening, let us know.
        </p>
        {error.digest && <p className="mt-2 text-xs text-muted-foreground">Reference: {error.digest}</p>}
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button variant="ink" onClick={reset}>Try again</Button>
          <Button asChild variant="outline"><Link href="/">Back to home</Link></Button>
        </div>
      </div>
    </div>
  );
}
