"use client";

import { useEffect, useState } from "react";

type Provider = "GOOGLE" | "FACEBOOK";
const LABEL: Record<Provider, string> = { GOOGLE: "Google", FACEBOOK: "Facebook" };

/**
 * The provider buttons. Still plain links (the whole flow is server-side redirects), but after a click the buttons show a
 * "Redirecting…" state and stop accepting clicks, so a double click cannot start two flows (the second would overwrite the
 * first one's state cookie and fail). The state is reset when the page is restored from the back/forward cache.
 */
export function SocialLoginLinks({ providers, query }: { providers: Provider[]; query: string }) {
  const [busy, setBusy] = useState<Provider | null>(null);

  useEffect(() => {
    const reset = (e: PageTransitionEvent) => { if (e.persisted) setBusy(null); };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  return (
    <div className="grid gap-2" aria-busy={busy !== null}>
      {providers.map((p) => (
        <a
          key={p}
          href={`/api/auth/oauth/${p.toLowerCase()}/start${query}`}
          aria-disabled={busy !== null}
          onClick={(e) => { if (busy) e.preventDefault(); else setBusy(p); }}
          className={`flex h-11 items-center justify-center rounded-[4px] border border-border text-sm font-medium hover:border-foreground ${busy && busy !== p ? "opacity-50" : ""} ${busy ? "pointer-events-none" : ""}`}
        >
          {busy === p ? `Redirecting to ${LABEL[p]}…` : `Continue with ${LABEL[p]}`}
        </a>
      ))}
      <p role="status" className="sr-only">{busy ? `Redirecting to ${LABEL[busy]} to sign in` : ""}</p>
    </div>
  );
}
