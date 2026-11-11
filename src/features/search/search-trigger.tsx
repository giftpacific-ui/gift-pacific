"use client";

import type { ComponentProps } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSearchUiStore } from "@/features/search/search-ui-store";

/** Icon button that opens the search overlay (a real <button>: keyboard + screen-reader friendly). */
export function SearchTrigger({ className, ...props }: ComponentProps<typeof Button>) {
  const open = useSearchUiStore((s) => s.open);
  return (
    <Button variant="ghost" size="icon" aria-label="Search" aria-haspopup="dialog" className={className} onClick={open} {...props}>
      <Search />
    </Button>
  );
}
