import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_GOOGLE_SHEET_URL } from '@/data/products';

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();

    const sheetUrl =
      process.env.GOOGLE_SHEET_URL ||
      process.env.NEXT_PUBLIC_GOOGLE_SHEET_URL ||
      DEFAULT_GOOGLE_SHEET_URL;

    // Enhance device info if not provided
    const userAgent = req.headers.get('user-agent') || '';
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'Direct';

    const payload = {
      type: 'order',
      name: data.name || 'Anonymous',
      phone: data.phone || '',
      address: data.address || '',
      product: data.product || 'Unknown Item',
      basePrice: data.basePrice || 0,
      deliveryCharge: data.deliveryCharge || 0,
      deliveryArea: data.deliveryArea || 'Inside Dhaka',
      price: data.price || 0,
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
      message: 'Order recorded successfully',
      data: payload,
    });
  } catch (error) {
    console.error('Order API error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to process order' },
      { status: 500 }
    );
  }
}
