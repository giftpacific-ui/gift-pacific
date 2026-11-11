import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="container-boutique grid min-h-[70vh] place-items-center py-20 text-center">
      <div className="max-w-md">
        <p className="font-heading text-[7rem] leading-none font-semibold text-primary/25" aria-hidden>
          404
        </p>
        <h1 className="mt-2 font-heading text-4xl leading-tight font-semibold">This page has wandered off</h1>
        <p className="mt-3 text-muted-foreground">The page you&apos;re looking for doesn&apos;t exist or has moved.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button asChild variant="ink"><Link href="/shop">Browse the shop</Link></Button>
          <Button asChild variant="outline"><Link href="/">Back to home</Link></Button>
        </div>
      </div>
    </main>
  );
}
