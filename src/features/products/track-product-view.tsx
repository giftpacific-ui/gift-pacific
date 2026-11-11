"use client";

import { useEffect } from "react";
import { trackViewContent } from "@/lib/analytics/events";

export function TrackProductView({
  id,
  name,
  price,
  currency,
}: {
  id: string;
  name: string;
  price: number;
  currency: string;
}) {
  useEffect(() => {
    trackViewContent({ id, name, price, currency });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return null;
}
