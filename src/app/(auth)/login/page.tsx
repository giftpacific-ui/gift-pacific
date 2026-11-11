import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SocialLoginButtons } from "@/features/auth/social-login-buttons";
import { LoginForm } from "@/features/auth/login-form";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { safeRedirectPath } from "@/lib/url-safety";

export const metadata: Metadata = { title: "Sign In" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; link?: string; redirect?: string }> }) {
  const sp = await searchParams;
  // Signed-in customers are sent on to where they were going (safe internal paths only) instead of seeing the login form.
  if (await getCurrentUser()) redirect(safeRedirectPath(sp.redirect, "/account"));
  return (
    <div className="space-y-6">
      <div className="space-y-1 text-center">
        <h1 className="font-heading text-2xl">Welcome back</h1>
        <p className="text-sm text-muted-foreground">
          Sign in to track orders, manage your wishlist, and check out faster.
        </p>
      </div>
            <SocialLoginButtons error={sp.error} link={sp.link} redirectTo={sp.redirect} />
      <Suspense>
        <LoginForm />
      </Suspense>
      <p className="text-center text-sm text-muted-foreground">
        New here?{" "}
        <Link href="/register" className="text-foreground underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
