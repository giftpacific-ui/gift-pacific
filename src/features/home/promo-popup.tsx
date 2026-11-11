"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type PopupBanner = {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  ctaLabel: string | null;
  ctaHref: string | null;
};

/** Shown at most once per browser session, never on checkout/account pages. */
export function PromoPopup({ banner }: { banner: PopupBanner }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const key = `giftpacific_popup_${banner.id}`;
  // branding-guard:allow (documented legacy compatibility, see HANDOFF_GIFTPACIFIC.md)
  const legacyKey = `ap_popup_${banner.id}`; // pre-rebrand session key, read only (allow-listed legacy reference)
  const suppressed = pathname.startsWith("/checkout") || pathname.startsWith("/account");

  useEffect(() => {
    if (suppressed) return;
    try {
      if (sessionStorage.getItem(key) || sessionStorage.getItem(legacyKey)) return;
    } catch {
      return; // storage blocked: don't risk showing it on every page
    }
    const timer = setTimeout(() => setOpen(true), 4000);
    return () => clearTimeout(timer);
  }, [key, legacyKey, suppressed]);

  function close() {
    setOpen(false);
    try {
      sessionStorage.setItem(key, "1");
    } catch {
      /* ignore */
    }
  }

  return (
    <Dialog open={open && !suppressed} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-md overflow-hidden p-0">
        <div className="relative aspect-4/3 w-full bg-sand">
          <Image src={banner.imageUrl} alt="" fill sizes="448px" className="object-cover" />
        </div>
        <div className="space-y-3 p-6 text-center">
          <DialogTitle className="font-heading text-2xl">{banner.title}</DialogTitle>
          <DialogDescription>{banner.subtitle ?? ""}</DialogDescription>
          {banner.ctaHref && (
            <Button asChild variant="ink" onClick={close}>
              <Link href={banner.ctaHref}>{banner.ctaLabel || "Learn more"}</Link>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
