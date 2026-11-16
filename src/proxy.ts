import { NextResponse, type NextRequest } from "next/server";
import { findActiveRedirect } from "@/server/services/redirect.service";
import { verifySessionToken, sessionCookieConfig, adminSessionCookieConfig } from "@/lib/auth/session";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Admin-managed redirects (Admin → SEO → Redirects). Public GET/HEAD paths only: admin, account, API, assets and /docs are
  // excluded by the matcher below. The lookup is an in-memory map refreshed every 30 s and fails open (never blocks a page).
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    !pathname.startsWith("/admin") &&
    !pathname.startsWith("/account") &&
    !pathname.startsWith("/docs")
  ) {
    const hit = await findActiveRedirect(pathname);
    if (hit) {
      const target = new URL(hit.to, request.url);
      // Keep the visitor's query string (UTM tags, etc.) unless the destination defines its own.
      if (!target.search) target.search = request.nextUrl.search;
      return NextResponse.redirect(target, hit.status);
    }
    return NextResponse.next();
  }

  // /docs is a demo-only roadmap page — never publicly reachable in
  // production, even via a direct URL. This is a route-level redirect
  // (not just hiding a UI link), checked here in addition to the page
  // component's own check, so it holds regardless of how the route is
  // reached.
  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    if (process.env.NEXT_PUBLIC_APP_ENV !== "demo") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  const isAdminRoute = pathname.startsWith("/admin");
  const isAccountRoute = pathname.startsWith("/account");
  const isAdminLogin = pathname === "/admin/login";

  if (!isAdminRoute && !isAccountRoute) {
    return NextResponse.next();
  }

  if (isAdminLogin) {
    return NextResponse.next();
  }

  // Admin and account routes are gated by two entirely separate cookies —
  // an admin session must never grant access to /account, and a customer
  // session must never grant access to /admin.
  const cookieName = isAdminRoute ? adminSessionCookieConfig.name : sessionCookieConfig.name;
  const token = request.cookies.get(cookieName)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    const loginUrl = new URL(
      isAdminRoute ? "/admin/login" : "/login",
      request.url,
    );
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAdminRoute && session.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/account/:path*",
    "/admin/:path*",
    "/docs",
    "/docs/:path*",
    // Every other public page (excludes API, Next internals and files with an extension such as images, sitemap.xml, robots.txt).
    "/((?!api/|_next/|admin|account|docs|.*\\..*).*)",
  ],
};
