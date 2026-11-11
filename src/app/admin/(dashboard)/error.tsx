"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="grid min-h-[40vh] place-items-center text-center">
      <div className="max-w-md">
        <h1 className="font-heading text-2xl font-semibold">This page failed to load</h1>
        <p className="mt-2 text-sm text-muted-foreground">Nothing was changed. Try again, or return to the dashboard.</p>
        {error.digest && <p className="mt-2 text-xs text-muted-foreground">Reference: {error.digest}</p>}
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Button variant="ink" onClick={reset}>Try again</Button>
          <Button asChild variant="outline"><Link href="/admin">Dashboard</Link></Button>
        </div>
      </div>
    </div>
  );
}
