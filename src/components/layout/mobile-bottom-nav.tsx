"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Heart, Home, Search, ShoppingBag, User } from "lucide-react";
import { CartCountBadge, useCartCount } from "@/features/cart/cart-button";
import { useCartUiStore } from "@/features/cart/cart-ui-store";
import { useSearchUiStore } from "@/features/search/search-ui-store";
import { cn } from "@/lib/utils";

const item =
  "relative flex h-full flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors focus-visible:outline-offset-[-2px]";

export function MobileBottomNav({ isSignedIn }: { isSignedIn: boolean }) {
  const pathname = usePathname();
  const openCart = useCartUiStore((s) => s.open);
  const openSearch = useSearchUiStore((s) => s.open);
  const count = useCartCount();

  const active = (on: boolean) => (on ? "text-primary" : "text-muted-foreground hover:text-foreground");

  return (
    <div className="fixed right-0 bottom-0 left-0 z-40 border-t border-border bg-background/95 backdrop-blur-md lg:hidden print:hidden">
      <nav aria-label="Quick navigation" className="flex h-16 items-center justify-around px-1 pb-[env(safe-area-inset-bottom)]">
        <Link href="/" className={cn(item, active(pathname === "/"))} aria-current={pathname === "/" ? "page" : undefined}>
          <Home className="size-5" aria-hidden />
          <span>Home</span>
        </Link>
        <button type="button" onClick={openSearch} className={cn(item, active(false))} aria-haspopup="dialog">
          <Search className="size-5" aria-hidden />
          <span>Search</span>
        </button>
        <button
          type="button"
          onClick={openCart}
          className={cn(item, active(false))}
          aria-haspopup="dialog"
          aria-label={count ? `Cart, ${count} item${count === 1 ? "" : "s"}` : "Cart"}
        >
          <span className="relative">
            <ShoppingBag className="size-5" aria-hidden />
            <CartCountBadge className="-top-1.5 -right-2.5" />
          </span>
          <span aria-hidden>Cart</span>
        </button>
        <Link
          href={isSignedIn ? "/account/wishlist" : "/login?redirect=/account/wishlist"}
          className={cn(item, active(pathname?.includes("/wishlist") ?? false))}
        >
          <Heart className="size-5" aria-hidden />
          <span>Wishlist</span>
        </Link>
        <Link
          href={isSignedIn ? "/account" : "/login"}
          className={cn(item, active((pathname?.includes("/account") || pathname?.includes("/login")) ?? false))}
        >
          <User className="size-5" aria-hidden />
          <span>{isSignedIn ? "Account" : "Sign in"}</span>
        </Link>
      </nav>
    </div>
  );
}
