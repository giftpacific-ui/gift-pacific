import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth/current-user";
import {
  AdminSidebar,
  AdminMobileHeader,
} from "@/features/admin/admin-sidebar";
import { AdminBreadcrumbs } from "@/features/admin/admin-breadcrumbs";
import { siteConfig } from "@/config/site";
import { getStoreSettings } from "@/server/services/admin-settings.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

export default async function AdminDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // A cookie can be cryptographically valid yet stale (user deleted/deactivated/demoted, DB reseeded). requireAdmin() THROWS in
  // that case, which rendered an error page; a server-side redirect to the login page is the correct behaviour.
  if (!(await getCurrentAdmin())) redirect("/admin/login");

  // Categories er poriborte store settings fetch kora hocche
  const storeSettings = await getStoreSettings();

  const storeName = storeSettings?.storeName || siteConfig.name;
  const logoUrl = storeSettings?.logoUrl;

  return (
    <div className="min-h-screen bg-sand lg:flex">
      <AdminSidebar storeName={storeName} logoUrl={logoUrl} />
      <div className="min-w-0 flex-1">
        <AdminMobileHeader storeName={storeName} logoUrl={logoUrl} />
        <main id="main-content" className="min-w-0 overflow-x-hidden p-4 sm:p-6 lg:p-8">
          <AdminBreadcrumbs />
          {children}
        </main>
      </div>
    </div>
  );
}
