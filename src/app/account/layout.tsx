import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { StorefrontOverlays } from "@/components/layout/storefront-overlays";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { AccountSidebar } from "@/features/account/account-sidebar";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getMyUnreadNotificationCount } from "@/server/services/notification.service";

// Account pages depend on the session cookie: never serve a cached copy after logout.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "My account", robots: { index: false, follow: false } };

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  // The proxy only proves the cookie is well-formed. This confirms the customer still exists and is active
  // (a stale cookie must send the visitor to sign in, not to an error page).
  if (!(await getCurrentUser())) redirect("/login?redirect=/account");
  const unreadCount = await getMyUnreadNotificationCount();
  return (
    <>
      <Navbar />
      <MobileBottomNav isSignedIn />
      <main id="main-content" className="flex-1">
        <div className="container-boutique flex flex-col gap-6 py-8 sm:py-12 lg:flex-row lg:gap-8">
          <AccountSidebar unreadCount={unreadCount} />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </main>
      <div className="pb-16 lg:pb-0">
        <Footer />
      </div>
      <StorefrontOverlays />
    </>
  );
}
