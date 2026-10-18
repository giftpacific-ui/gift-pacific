import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_GOOGLE_SHEET_URL } from '@/data/products';

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();

    const sheetUrl =
      process.env.GOOGLE_SHEET_URL ||
      process.env.NEXT_PUBLIC_GOOGLE_SHEET_URL ||
      DEFAULT_GOOGLE_SHEET_URL;

    const userAgent = req.headers.get('user-agent') || '';
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'Direct';

    const payload = {
      type: 'contact',
      name: data.name || 'Anonymous',
      phone: data.phone || '',
      message: data.message || '',
      device: data.device || userAgent.slice(0, 100),
      location: data.location || ip.split(',')[0].trim(),
      timestamp: new Date().toISOString(),
    };

    if (sheetUrl) {
      try {
        await fetch(sheetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          redirect: 'follow',
        });
      } catch (err) {
        console.warn('Google Sheet forward warning (handled):', err);
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Message sent successfully',
      data: payload,
    });
  } catch (error) {
    console.error('Contact API error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
