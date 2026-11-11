"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import Script from "next/script";
import { GA4_ID_PATTERN, GTM_ID_PATTERN, isValidLinkedInId, isValidPixelId, isValidTikTokId } from "@/lib/analytics/ids";
import { CONSENT_EVENT, readConsent, writeConsent, type ConsentState } from "@/lib/analytics/consent";
import { analyticsPath, isTrackablePath, shouldSendPageView } from "@/lib/analytics/privacy";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    fbq?: ((...args: unknown[]) => void) & { disablePushState?: boolean };
  }
}

/**
 * Page views for client-side navigations. The very first page view is sent by
 * the GA4 / Pixel snippets themselves when they load, so this component skips
 * its first run and only reports later route changes — each one exactly once,
 * with the sanitized path (no query string / hash / order number).
 */
function RouteChangeTracker({ hasGa4, hasPixel, hasTikTok }: { hasGa4: boolean; hasPixel: boolean; hasTikTok: boolean }) {
  const pathname = usePathname();
  const lastSent = useRef<string | null>(null);
  const isFirstRun = useRef(true);

  useEffect(() => {
    const path = analyticsPath(pathname);
    if (isFirstRun.current) {
      isFirstRun.current = false;
      lastSent.current = path; // initial page view is sent by the snippets
      return;
    }
    if (!shouldSendPageView(lastSent.current, path)) return;
    lastSent.current = path;
    if (!isTrackablePath(pathname)) return;

    if (hasGa4 && window.gtag) {
      window.gtag("event", "page_view", { page_path: path, page_location: `${window.location.origin}${path}` });
    }
        if (hasPixel && window.fbq) {
      window.fbq("track", "PageView");
    }
    if (hasTikTok && window.ttq) {
      window.ttq.page();
    }
  }, [pathname, hasGa4, hasPixel, hasTikTok]);

  return null;
}

/**
 * Renders tracking scripts for whichever IDs are configured. IDs are passed
 * in (resolved server-side in the root layout from StoreSettings, falling
 * back to NEXT_PUBLIC_* env vars) and validated against the real ID formats
 * because they are interpolated into inline scripts.
 *
 * `trackingId` is either a GA4 Measurement ID ("G-…", loaded via gtag.js) or
 * a GTM container ID ("GTM-…"), detected from its prefix.
 *
 * Nothing is loaded on admin, account or authentication pages.
 */
export function AnalyticsScripts({
  trackingId,
  pixelId,
  tiktokId,
  linkedinId,
}: {
  trackingId?: string | null;
  pixelId?: string | null;
  tiktokId?: string | null;
  linkedinId?: string | null;
}) {
  const pathname = usePathname();
  const isGa4 = !!trackingId && GA4_ID_PATTERN.test(trackingId);
  const isGtm = !!trackingId && GTM_ID_PATTERN.test(trackingId);
    if (!isValidPixelId(pixelId)) pixelId = null;
  const tiktok = isValidTikTokId(tiktokId) ? tiktokId : null;
  const linkedin = isValidLinkedInId(linkedinId) ? linkedinId : null;
  // A GTM container normally contains its own GA4 tag: never ALSO load gtag.js for the same site.

  if (!isTrackablePath(pathname)) return null;

  return (
    <>
      {trackingId && isGa4 && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${trackingId}`} strategy="afterInteractive" />
          <Script id="ga4-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${trackingId}', { page_location: window.location.origin + window.location.pathname });
            `}
          </Script>
        </>
      )}

      {trackingId && isGtm && (
        <>
          <Script id="gtm-init" strategy="afterInteractive">
            {`
              (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start': new Date().getTime(),event:'gtm.js'});
              var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';
              j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
              })(window,document,'script','dataLayer','${trackingId}');
            `}
          </Script>
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${trackingId}`}
              height="0"
              width="0"
              style={{ display: "none", visibility: "hidden" }}
              title="gtm"
            />
          </noscript>
        </>
      )}

      {pixelId && (
        <Script id="meta-pixel-init" strategy="afterInteractive">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq.disablePushState = true;
            fbq('init', '${pixelId}');
            fbq('track', 'PageView');
          `}
        </Script>
      )}

            {tiktok && (
        <Script id="tiktok-pixel-init" strategy="afterInteractive">
          {`
            !function (w, d, t) {
              if (w.__ttqLoaded) return; w.__ttqLoaded = true;
              w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || [];
              ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];
              ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } };
              for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
              ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e };
              ttq.load = function (e, n) {
                var i = "https://analytics.tiktok.com/i18n/pixel/events.js";
                ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = i; ttq._t = ttq._t || {}; ttq._t[e] = +new Date; ttq._o = ttq._o || {}; ttq._o[e] = n || {};
                var o = document.createElement("script"); o.type = "text/javascript"; o.async = !0; o.src = i + "?sdkid=" + e + "&lib=" + t;
                var a = document.getElementsByTagName("script")[0]; a.parentNode.insertBefore(o, a)
              };
              ttq.load('${tiktok}'); ttq.page();
            }(window, document, 'ttq');
          `}
        </Script>
      )}

      {linkedin && (
        <Script id="linkedin-insight-init" strategy="afterInteractive">
          {`
            if (!window.__linkedinLoaded) {
              window.__linkedinLoaded = true;
              window._linkedin_partner_id = "${linkedin}";
              window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
              window._linkedin_data_partner_ids.push(window._linkedin_partner_id);
              (function (l) {
                if (!l) { window.lintrk = function (a, b) { window.lintrk.q.push([a, b]) }; window.lintrk.q = [] }
                var s = document.getElementsByTagName("script")[0];
                var b = document.createElement("script"); b.type = "text/javascript"; b.async = true;
                b.src = "https://snap.licdn.com/li.lms-analytics/insight.min.js"; s.parentNode.insertBefore(b, s);
              })(window.lintrk);
            }
          `}
        </Script>
      )}

      {(isGa4 || pixelId || tiktok) && <RouteChangeTracker hasGa4={isGa4} hasPixel={Boolean(pixelId)} hasTikTok={Boolean(tiktok)} />}
    </>
  );
}

function subscribeConsent(onChange: () => void) {
  window.addEventListener(CONSENT_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CONSENT_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The single entry point used by the root layout.
 *  - consentMode "OFF": scripts load as before (no banner).
 *  - consentMode "OPT_IN": NOTHING third-party loads, and no request is made, until the visitor
 *    accepts. Their choice is remembered and can be changed from the small "Privacy choices" link.
 */
export function AnalyticsRoot({
  consentMode,
  ...ids
}: {
  consentMode: "OFF" | "OPT_IN";
  trackingId?: string | null;
  pixelId?: string | null;
  tiktokId?: string | null;
  linkedinId?: string | null;
}) {
  const pathname = usePathname();
  // External store (localStorage + custom event). The server snapshot is "loading", so SSR and the
  // first client render agree and nothing third-party loads before the stored choice is read.
  const consent = useSyncExternalStore<ConsentState | "loading">(
    subscribeConsent,
    readConsent,
    () => "loading",
  );

  const anyTracker = Boolean(ids.trackingId || ids.pixelId || ids.tiktokId || ids.linkedinId);
  if (!anyTracker || !isTrackablePath(pathname)) return null;
  if (consentMode === "OFF") return <AnalyticsScripts {...ids} />;
  if (consent === "loading") return null;

  return (
    <>
      {consent === "granted" && <AnalyticsScripts {...ids} />}
      {consent === "unknown" ? (
        <div role="dialog" aria-label="Cookie preferences" className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl rounded-[4px] border border-border bg-background p-4 text-sm shadow-lg">
          <p>We would like to use analytics and advertising cookies to understand how the shop is used. They stay off unless you accept.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="h-9 rounded-[4px] bg-foreground px-4 text-background" onClick={() => writeConsent("granted")}>Accept</button>
            <button type="button" className="h-9 rounded-[4px] border border-border px-4" onClick={() => writeConsent("denied")}>No thanks</button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="fixed bottom-2 left-2 z-40 rounded-[4px] bg-background/90 px-2 py-1 text-xs text-muted-foreground underline"
          onClick={() => {
            // Withdrawing consent must stop the trackers that are already running: reload clean.
            writeConsent(consent === "granted" ? "denied" : "granted");
            if (consent === "granted") window.location.reload();
          }}
        >
          Privacy choices: {consent === "granted" ? "analytics on" : "analytics off"}
        </button>
      )}
    </>
  );
}
