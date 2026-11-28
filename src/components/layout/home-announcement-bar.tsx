"use client";

import { usePathname } from "next/navigation";
import { AnnouncementBar } from "./announcement-bar";

export function HomeAnnouncementBar() {
  const pathname = usePathname();

  if (pathname !== "/") return null;

  return <AnnouncementBar />;
}
