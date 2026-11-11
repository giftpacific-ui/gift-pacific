"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function MobileFilters({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 rounded-full px-4 h-10 border-border"
        >
          <SlidersHorizontal className="size-4" />
          <span>Filters</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-[300px] sm:w-[380px] overflow-y-auto"
      >
        <SheetHeader className="mb-6 text-left">
          <SheetTitle className="font-heading text-xl font-bold">
            Filters & Categories
          </SheetTitle>
        </SheetHeader>
        <div className="space-y-6 pb-12" onClick={() => setOpen(false)}>
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
