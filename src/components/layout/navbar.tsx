import Link from "next/link";
import Image from "next/image";
import { ChevronDown, Heart, User } from "lucide-react";
import { getSession } from "@/lib/auth/current-user";
import { Button } from "@/components/ui/button";
import { StickyHeader } from "@/components/layout/sticky-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { CartButton } from "@/features/cart/cart-button";
import { SearchTrigger } from "@/features/search/search-trigger";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { getCategoryTree } from "@/server/services/product.service";
import { getActiveCampaign } from "@/server/services/campaign.service";
import { siteConfig } from "@/config/site";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type CategoryNode = { id: string; name: string; slug: string; children: CategoryNode[] };

const linkClass =
  "relative py-1 text-[0.95rem] font-medium text-foreground/90 transition-colors hover:text-foreground after:absolute after:bottom-0 after:left-0 after:h-[1.5px] after:w-full after:origin-right after:scale-x-0 after:bg-primary after:transition-transform after:duration-300 hover:after:origin-left hover:after:scale-x-100 focus-visible:after:scale-x-100";

function renderCategoryMenuItems(items: CategoryNode[]) {
  return items.map((cat) =>
    cat.children.length > 0 ? (
      <DropdownMenuSub key={cat.id}>
        <DropdownMenuSubTrigger className="w-full cursor-pointer">{cat.name}</DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent className="w-52 bg-card">
            <DropdownMenuItem asChild>
              <Link href={`/shop/${cat.slug}`} className="w-full cursor-pointer font-medium text-primary">
                View all {cat.name}
              </Link>
            </DropdownMenuItem>
            {renderCategoryMenuItems(cat.children)}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
    ) : (
      <DropdownMenuItem key={cat.id} asChild>
        <Link href={`/shop/${cat.slug}`} className="w-full cursor-pointer">
          {cat.name}
        </Link>
      </DropdownMenuItem>
    ),
  );
}

export async function Navbar() {
  const [session, storeSettings, categoryTree, campaign] = await Promise.all([
    getSession(),
    getStoreSettings(),
    getCategoryTree(),
    getActiveCampaign(),
  ]);

  const storeName = storeSettings?.storeName || siteConfig.name;
  const logoUrl = storeSettings?.logoUrl;
  const roots = (categoryTree as CategoryNode[]).map((c) => ({ id: c.id, name: c.name, slug: c.slug }));

  const logo = (
    <Link href="/" className="inline-flex items-center gap-2 font-heading text-[1.55rem] leading-none font-bold tracking-tight" aria-label={`${storeName} — home`}>
      {logoUrl ? (
        <Image src={logoUrl} alt={storeName} width={98} height={64} className="max-h-11 w-auto object-contain transition-[max-height] duration-300 group-data-[scrolled=true]:max-h-9 sm:max-h-12" priority />
      ) : (
        <>
          <span className="truncate">{storeName}</span>
          <span aria-hidden className="size-2 shrink-0 rotate-45 bg-primary" />
        </>
      )}
    </Link>
  );

  return (
    <StickyHeader>
      <div className="container mx-auto px-3 flex h-16 items-center justify-between gap-3 transition-[height] duration-300 group-data-[scrolled=true]:h-14 sm:h-[4.5rem] sm:group-data-[scrolled=true]:h-16 lg:gap-8">
        {/* Mobile: menu trigger */}
        <div className="flex items-center lg:hidden">
          <MobileNav
            logoUrl={logoUrl}
            storeName={storeName}
            categories={roots}
            campaignName={campaign?.name ?? null}
            isSignedIn={Boolean(session)}
          />
        </div>

        <div className="flex flex-1 items-center justify-center lg:flex-none lg:justify-start">{logo}</div>

        <nav className="hidden min-w-0 items-center gap-5 whitespace-nowrap xl:gap-8 lg:flex" aria-label="Main">
          <Link href="/" className={linkClass}>Home</Link>
          <Link href="/shop" className={linkClass}>Shop</Link>
          {roots.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger className={`${linkClass} flex cursor-pointer items-center gap-1 outline-none`}>
                Categories <ChevronDown className="size-4" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52 bg-card">
                <DropdownMenuItem asChild>
                  <Link href="/shop" className="w-full cursor-pointer font-medium">All products</Link>
                </DropdownMenuItem>
                {renderCategoryMenuItems(categoryTree as CategoryNode[])}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {campaign && (
            <Link href="/campaign" className={`${linkClass} max-w-40 truncate text-primary`}>
              {campaign.name}
            </Link>
          )}
          <Link href="/boxes" className={linkClass}>Our Boxes</Link>
          <Link href="/build-your-own-combo" className={linkClass}>Build your combo</Link>
          <Link href="/about-us" className={`${linkClass} hidden xl:inline-block`}>Our story</Link>
          <Link href="/contact" className={`${linkClass} hidden xl:inline-block`}>Contact</Link>
        </nav>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <SearchTrigger />
          <Button variant="ghost" size="icon" asChild aria-label="Wishlist" className="hidden lg:inline-flex">
            <Link href={session ? "/account/wishlist" : "/login?redirect=/account/wishlist"}>
              <Heart />
            </Link>
          </Button>
          <Button variant="ghost" size="icon" asChild aria-label={session ? "My account" : "Sign in"} className="hidden lg:inline-flex">
            <Link href={session ? "/account" : "/login"}>
              <User />
            </Link>
          </Button>
          <CartButton className="hidden lg:inline-flex" />
        </div>
      </div>
    </StickyHeader>
  );
}
