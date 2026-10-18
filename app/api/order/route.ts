import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_GOOGLE_SHEET_URL } from "@/data/products";

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();

    const sheetUrl =
      process.env.GOOGLE_SHEET_URL ||
      process.env.NEXT_PUBLIC_GOOGLE_SHEET_URL ||
      DEFAULT_GOOGLE_SHEET_URL;

    // Enhance device info if not provided
    const userAgent = req.headers.get("user-agent") || "";
    const ip =
      req.headers.get("x-forwarded-for") ||
      req.headers.get("x-real-ip") ||
      "127.0.0.1";

    const payload = {
      type: "order",
      name: data.name || "Anonymous",
      phone: data.phone || "",
      address: data.address || "",
      product: data.product || "Unknown Item",
      basePrice: data.basePrice || 0,
      deliveryCharge: data.deliveryCharge || 0,
      deliveryArea: data.deliveryArea || "Inside Dhaka",
      price: data.price || 0,
      device: data.device || userAgent.slice(0, 100),
      location: data.location || ip.split(",")[0].trim(),
      timestamp: new Date().toISOString(),
    };

    // 1. Send data to Google Sheet
    if (sheetUrl) {
      try {
        await fetch(sheetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          redirect: "follow",
        });
      } catch (err) {
        console.warn("Google Sheet forward warning (handled):", err);
      }
    }

    // 2. Meta Conversions API (CAPI) Integration
    const pixelId =
      process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID;
    const accessToken = process.env.FB_ACCESS_TOKEN;

    if (pixelId && accessToken) {
      try {
        const clientIp = ip.split(",")[0].trim();
        const capiPayload = {
          data: [
            {
              event_name: "Purchase",
              event_time: Math.floor(Date.now() / 1000),
              event_id: data.eventId, // Client-side eventId matching for deduplication
              event_source_url: req.headers.get("referer") || "",
              action_source: "website",
              user_data: {
                client_ip_address: clientIp,
                client_user_agent: userAgent,
                ph: data.phone
                  ? [data.phone.replace(/[^0-9]/g, "")]
                  : undefined,
              },
              custom_data: {
                currency: "BDT",
                value: Number(data.price) || 0,
                content_name: data.product,
              },
            },
          ],
        };

        await fetch(
          `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(capiPayload),
          },
        );
      } catch (capiErr) {
        console.warn("Meta CAPI error (handled):", capiErr);
      }
    }

    return NextResponse.json({
      success: true,
      message: "Order recorded successfully",
      data: payload,
    });
  } catch (error) {
    console.error("Order API error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process order" },
      { status: 500 },
    );
  }
}
