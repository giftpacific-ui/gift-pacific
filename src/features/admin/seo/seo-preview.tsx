import { clampText } from "@/lib/seo";

const TITLE_SHOWN = 60;
const DESC_SHOWN = 160;

/**
 * Google-style snippet + social card. Both are ESTIMATES drawn from the typed values: Google decides the real title, snippet and
 * image itself and may rewrite or truncate them; each network crops its own card. Nothing here predicts ranking.
 */
export function SeoPreview({
  title, description, url, image, siteName, ogTitle, ogDescription, twitterCard = "summary_large_image",
}: {
  title: string; description: string; url: string; image?: string | null; siteName: string;
  ogTitle?: string; ogDescription?: string; twitterCard?: "summary" | "summary_large_image";
}) {
  const shownTitle = clampText(title || "Untitled page", TITLE_SHOWN);
  const shownDesc = clampText(description, DESC_SHOWN);
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const path = (() => { try { return new URL(url).pathname.replace(/\/$/, "").split("/").filter(Boolean).join(" › "); } catch { return ""; } })();
  const card = twitterCard === "summary" || !image ? "summary" : "large";
  return (
    <div className="space-y-4" aria-label="SEO preview">
      <section className="space-y-1.5 rounded-lg border border-border/70 bg-card p-4">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Search result preview (estimate)</h3>
        <p className="truncate text-xs text-muted-foreground">{host}{path ? ` › ${path}` : ""}</p>
        <p className="text-lg leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">{shownTitle}</p>
        <p className="text-sm leading-snug text-muted-foreground">{shownDesc || "No meta description set: a search engine will choose text from the page."}</p>
      </section>
      <section className="space-y-2 rounded-lg border border-border/70 bg-card p-4">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Social share preview (estimate)</h3>
        <div className={card === "large" ? "overflow-hidden rounded-md border border-border/70" : "flex overflow-hidden rounded-md border border-border/70"}>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element -- admin preview of an arbitrary typed URL; not a storefront image
            <img src={image} alt="" className={card === "large" ? "aspect-[1.91/1] w-full bg-secondary object-cover" : "size-24 shrink-0 bg-secondary object-cover"} />
          ) : (
            <div className={card === "large" ? "grid aspect-[1.91/1] w-full place-items-center bg-secondary text-xs text-muted-foreground" : "grid size-24 shrink-0 place-items-center bg-secondary text-xs text-muted-foreground"}>No image</div>
          )}
          <div className="min-w-0 space-y-0.5 p-3">
            <p className="truncate text-[0.7rem] text-muted-foreground uppercase">{host}</p>
            <p className="line-clamp-2 text-sm font-semibold">{clampText(ogTitle || title || siteName, 70)}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground">{clampText(ogDescription || description, 120)}</p>
          </div>
        </div>
      </section>
      <p className="text-xs text-muted-foreground">
        Previews are estimates built from the values above. Google and social networks choose their own title, snippet and image, and results can differ.
      </p>
    </div>
  );
}
