import "server-only";
import { isValidPixelId } from "@/lib/analytics/ids";

type ServerEventName = "Purchase" | "InitiateCheckout";

type ServerEventPayload = {
  value?: number;
  currency?: string;
  content_type?: string;
  /** Our public order number; never an internal database id. */
  order_id?: string;
};

/**
 * Server-side counterpart to the client pixel/GTM events (features/analytics).
 * This is intentionally a thin, safe-to-no-op wrapper: if META_PIXEL_ID /
 * a conversions API access token aren't configured, it just logs in dev and
 * returns — it never throws, since analytics must never break checkout.
 */
export async function trackServerEvent(
  event: ServerEventName,
  payload: ServerEventPayload,
    /** Same id the browser sends, so Meta counts the event once. */
  eventId?: string,
  options: {
    /** The pixel configured in Admin → Settings (preferred); falls back to the env var. */
    pixelId?: string | null;
    /** With "OPT_IN" the server cannot prove the visitor consented, so it sends nothing. */
    consentMode?: "OFF" | "OPT_IN";
    pageUrl?: string;
  } = {},
) {
  if (options.consentMode === "OPT_IN") return;
    // The SAME effective id the browser uses (admin setting first, then the env var), and only
  // if it has the expected shape — it is placed in a URL path.
  const candidate = options.pixelId || process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const pixelId = isValidPixelId(candidate) ? candidate : undefined;
  const accessToken = process.env.META_CONVERSIONS_API_TOKEN;

  if (!pixelId || !accessToken) {
    if (process.env.NODE_ENV === "development") {
      // Development visibility only; never logged in production.
      console.info(`[analytics:server] ${event}`, payload);
    }
    return;
  }

  try {
    await fetch(`https://graph.facebook.com/v20.0/${pixelId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [
          {
            event_name: event,
            ...(eventId ? { event_id: eventId } : {}),
            event_time: Math.floor(Date.now() / 1000),
                        action_source: "website",
            ...(options.pageUrl ? { event_source_url: options.pageUrl } : {}),
            custom_data: payload,
          },
        ],
        access_token: accessToken,
      }),
    });
  } catch {
    // Analytics failures must never break the checkout flow.
  }
}
