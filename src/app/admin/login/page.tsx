import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth/current-user";
import { safeRedirectPath } from "@/lib/url-safety";
import AdminLoginView from "./admin-login-view";

export const metadata: Metadata = {
  title: "Admin sign in",
  robots: { index: false, follow: false },
};
// Reads cookies: must be rendered per request, never statically cached across logins/logouts.
export const dynamic = "force-dynamic";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  // An already signed-in admin has no business on the login page.
  if (await getCurrentAdmin()) {
    const sp = await searchParams;
    const target = safeRedirectPath(sp.redirect, "/admin");
    redirect(target.startsWith("/admin") ? target : "/admin");
  }
  return <AdminLoginView />;
}
