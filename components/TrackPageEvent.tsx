/* eslint-disable react-hooks/exhaustive-deps */
// components/TrackPageEvent.tsx
"use client";

import { useEffect } from "react";
import { event } from "@/lib/fpixel";

interface Props {
  eventName: string;
  data?: Record<string, any>;
}

export default function TrackPageEvent({ eventName, data = {} }: Props) {
  useEffect(() => {
    event(eventName, data);
  }, [eventName, JSON.stringify(data)]);

  return null;
}
