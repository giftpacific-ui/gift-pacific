import type { Metadata } from "next";
import Link from "next/link";
import { SocialLoginButtons } from "@/features/auth/social-login-buttons";
import { RegisterForm } from "@/features/auth/register-form";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Create Account" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/account");
  return (
    <div className="space-y-6">
      <div className="space-y-1 text-center">
        <h1 className="font-heading text-2xl">Create your account</h1>
        <p className="text-sm text-muted-foreground">
          Save addresses, track orders, and keep a wishlist of your favorite pieces.
        </p>
      </div>
            <SocialLoginButtons />
      <RegisterForm />
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
