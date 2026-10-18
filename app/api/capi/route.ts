// app/api/capi/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { eventName, eventId, eventSourceUrl, userData, customData } = body;

    const PIXEL_ID = process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID;
    const ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

    // Meta Conversions API Graph Endpoint
    const url = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`;

    const payload = {
      data: [
        {
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId, // Deduplication-এর জন্য Client Pixel ও CAPI-তে Event ID একই হতে হবে
          event_source_url: eventSourceUrl,
          action_source: "website",
          user_data: {
            client_ip_address:
              req.headers.get("x-forwarded-for") || "127.0.0.1",
            client_user_agent: req.headers.get("user-agent"),
            // ইমেইল বা ফোন নম্বর থাকলে SHA-256 দিয়ে Hash করে পাঠাতে হয়
            em: userData?.email ? [userData.email] : undefined,
            ph: userData?.phone ? [userData.phone] : undefined,
          },
          custom_data: customData, // e.g. { value: 500, currency: 'BDT' }
        },
      ],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: "CAPI error", details: error },
      { status: 500 },
    );
  }
}
