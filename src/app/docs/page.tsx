import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CheckCircle2, Sparkles, Rocket } from "lucide-react";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { getSession } from "@/lib/auth/current-user";
import { StorefrontOverlays } from "@/components/layout/storefront-overlays";
import { siteConfig } from "@/config/site";
import { roadmapData } from "@/config/roadmap";

export const metadata: Metadata = { title: "Roadmap & Documentation" };

export default async function DocsPage() {
  const session = await getSession();
  // Demo-only route. Checked here (page-level) AND in proxy.ts
  // (route-level, so a direct URL visit is redirected before this page
  // even renders) — not just hidden in the UI.
  if (process.env.NEXT_PUBLIC_APP_ENV !== "demo") {
    redirect("/");
  }

  return (
    <>
      <Navbar />
      <MobileBottomNav isSignedIn={!!session} />
      <main id="main-content" className="flex-1">
      <div className="container-boutique py-16">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-primary">
          {siteConfig.name} — Product Documentation
        </p>
        <h1 className="mt-3 font-heading text-4xl">Roadmap &amp; Release Notes</h1>
        <p className="mt-4 text-muted-foreground">
          Current release: <span className="font-semibold text-foreground">{roadmapData.currentRelease}</span>
        </p>
      </div>

      <div className="mx-auto mt-14 grid max-w-4xl gap-8 sm:grid-cols-1">
        <section className="rounded-2xl border border-border/70 bg-card p-8">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-primary" />
            <h2 className="font-heading text-2xl">V1.0 — Completed</h2>
          </div>
          <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
            {roadmapData.v1Completed.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-foreground/85">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary/70" />
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-border/70 bg-secondary/40 p-8">
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-muted-foreground" />
            <h2 className="font-heading text-2xl">V1.1 — Planned</h2>
          </div>
          <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
            {roadmapData.v1_1Planned.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Sparkles className="mt-0.5 size-4 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-dashed border-border/70 p-8">
          <div className="flex items-center gap-2">
            <Rocket className="size-5 text-muted-foreground" />
            <h2 className="font-heading text-2xl">V2 — Planned</h2>
          </div>
          <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
            {roadmapData.v2Planned.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Rocket className="mt-0.5 size-4 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </section>
      </div>
      </div>
      </main>
      <div className="pb-16 lg:pb-0">
        <Footer />
      </div>
      <StorefrontOverlays />
    </>
  );
}
