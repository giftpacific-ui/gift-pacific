// components/TiktokPixel.tsx
"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Script from "next/script";
import { useEffect, Suspense } from "react";

// TypeScript window type extension
declare global {
  interface Window {
    ttq: any;
  }
}

function PixelTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const pixelId = process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID;

  useEffect(() => {
    if (pixelId && typeof window !== "undefined" && window.ttq) {
      window.ttq.page();
    }
  }, [pathname, searchParams, pixelId]);

  return null;
}

export default function TiktokPixel() {
  const pixelId = process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID;

  if (!pixelId) return null;

  return (
    <>
      <Suspense fallback={null}>
        <PixelTracker />
      </Suspense>

      <Script id="tiktok-pixel-init" strategy="afterInteractive">
        {`
          !function (w, d, t) {
            w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._for[t]||[],n=0;n<e.length;n++)ttq.setAndDefer(e[n],e[n].tagName?e[n].tagName():e[n]);return t};var s=d.createElement(t);s.type="text/javascript",s.async=!0,s.src="https://analytics.tiktok.com/i18n/pixel/events.js?sdkid="+t+"&lib="+t;var e=d.getElementsByTagName(t)[0];e.parentNode.insertBefore(s,e);
          }(window, document, 'ttq');

          ttq.load('${pixelId}');
          ttq.page();
        `}
      </Script>
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          height="1"
          width="1"
          style={{ display: "none" }}
          src={`https://analytics.tiktok.com/i18n/pixel/event.gif?sdkid=${pixelId}&event=PageView`}
          alt=""
        />
      </noscript>
    </>
  );
}
