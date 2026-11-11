"use client";

import { safeRedirectPath } from "@/lib/url-safety";
import { siteConfig } from "@/config/site";
import { useState, useTransition, Suspense } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter, useSearchParams } from "next/navigation";
import { loginSchema, type LoginInput } from "@/lib/validations/auth";
import { loginAdmin } from "@/server/actions/auth.actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import Image from "next/image";

function AdminLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  function onSubmit(values: LoginInput) {
    setFormError(null);
    startTransition(async () => {
      const result = await loginAdmin(values);
      if (!result.success) {
        setFormError(result.message ?? "Invalid email or password.");
        return;
      }
      const redirect = safeRedirectPath(searchParams.get("redirect"), "/admin");
      router.push(redirect);
      router.refresh();
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-foreground/90 font-medium">Email</FormLabel>
              <FormControl>
                <Input 
                  type="email" 
                  placeholder="admin@giftpacific.com" 
                  className="bg-background/60 backdrop-blur-sm border-border/60"
                  {...field} 
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-foreground/90 font-medium">Password</FormLabel>
              <FormControl>
                <Input 
                  type="password" 
                  placeholder="••••••••" 
                  className="bg-background/60 backdrop-blur-sm border-border/60"
                  {...field} 
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {formError && <p className="text-sm text-destructive font-medium">{formError}</p>}
        <Button type="submit" className="w-full shadow-md" disabled={isPending}>
          {isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </Form>
  );
}

export default function AdminLoginView() {
  return (
    <div className="relative min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8 overflow-hidden">
      {/* Background Image */}
      <Image
        src="/img/login-bg.png"
        alt="Login background"
        fill
        priority
        className="object-cover -z-25 transition-all duration-700 ease-in-out"
      />
      
      {/* Lighter Overlay so background branding/logo remains visible */}
      <div className="absolute inset-0 bg-background/40 -z-20" />

      {/* Glassmorphism Card */}
      <div className="relative z-10 w-full max-w-md space-y-6 rounded-3xl border border-white/20 bg-card/80 dark:bg-card/70 backdrop-blur-xl p-8 shadow-2xl shadow-black/10">
        <div className="space-y-1 text-center">
          <p className="font-heading text-2xl font-bold tracking-tight">{siteConfig.name}</p>
          <p className="text-sm text-muted-foreground font-medium">Admin console</p>
        </div>
        <Suspense>
          <AdminLoginForm />
        </Suspense>
      </div>
    </div>
  );
}