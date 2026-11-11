"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

type Props = {
  logoUrl?: string | null;
  storeName: string;
  categories: { id: string; name: string; slug: string }[];
  campaignName: string | null;
  isSignedIn: boolean;
};

const bigLink =
  "block border-b border-border py-3.5 font-heading text-[1.7rem] leading-tight font-semibold transition-colors hover:text-primary focus-visible:text-primary";
const smallLink = "block py-2 text-[0.95rem] text-muted-foreground transition-colors hover:text-foreground";

/**
 * Full-height mobile menu. Built on the Radix sheet (focus trap, Esc to close,
 * scroll lock, labelled dialog) rather than a hand-rolled panel.
 */
export function MobileNav({ logoUrl, storeName, categories, campaignName, isSignedIn }: Props) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open menu">
          <Menu className="size-6" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-full max-w-md flex-col gap-0 overflow-y-auto bg-background p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border px-6 py-5">
          <SheetTitle className="font-heading text-2xl font-bold">
            {logoUrl ? <Image src={logoUrl} alt={storeName} width={110} height={40} className="max-h-10 w-auto object-contain" /> : storeName}
          </SheetTitle>
          <SheetDescription className="sr-only">Site navigation</SheetDescription>
        </SheetHeader>

        <nav aria-label="Mobile" className="flex flex-1 flex-col px-6 pt-2 pb-8">
          <Link href="/shop" onClick={close} className={bigLink}>Shop all</Link>
          {campaignName && (
            <Link href="/campaign" onClick={close} className={`${bigLink} text-primary`}>
              {campaignName}
            </Link>
          )}
          {categories.map((c) => (
            <Link key={c.id} href={`/shop/${c.slug}`} onClick={close} className={bigLink}>
              {c.name}
            </Link>
          ))}
          <Link href="/boxes" onClick={close} className={bigLink}>Our Boxes</Link>
          <Link href="/build-your-own-combo" onClick={close} className={bigLink}>Build your combo</Link>
          <Link href="/about-us" onClick={close} className={bigLink}>Our story</Link>
          <Link href="/contact" onClick={close} className={bigLink}>Contact</Link>

          <div className="mt-8 grid gap-1 border-t border-border pt-5">
            <Link href={isSignedIn ? "/account" : "/login"} onClick={close} className={smallLink}>
              {isSignedIn ? "My account" : "Sign in / Create account"}
            </Link>
            <Link href={isSignedIn ? "/account/orders" : "/login?redirect=/account/orders"} onClick={close} className={smallLink}>
              Track an order
            </Link>
            <Link href={isSignedIn ? "/account/wishlist" : "/login?redirect=/account/wishlist"} onClick={close} className={smallLink}>
              Wishlist
            </Link>
            <Link href="/shipping-returns" onClick={close} className={smallLink}>Shipping &amp; returns</Link>
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
