"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import {
  forgotPasswordSchema,
  type ForgotPasswordInput,
} from "@/lib/validations/auth";
import { requestPasswordReset } from "@/server/actions/password-reset.actions";
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

export default function ForgotPasswordPage() {
  const [isPending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);

  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  function onSubmit(values: ForgotPasswordInput) {
    startTransition(async () => {
      const result = await requestPasswordReset(values);
      if (result.devToken) {
        setDevLink(`/reset-password?token=${result.devToken}`);
      }
      setSent(true);
    });
  }

  // No email provider exists in V1: never claim an email was sent. In
  // production the form is replaced by an honest "contact us" notice.
  if (process.env.NODE_ENV === "production") {
    return (
      <div className="space-y-4 text-center">
        <h1 className="font-heading text-2xl">Reset your password</h1>
        <p className="text-sm text-muted-foreground">
          Automatic password-reset emails aren&apos;t available yet. Please{" "}
          <Link href="/contact" className="text-primary underline">
            contact us
          </Link>{" "}
          from the email address on your account and our team will help you regain access.
        </p>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="font-heading text-2xl">Reset link ready</h1>
        <p className="rounded-lg bg-secondary p-3 text-xs text-muted-foreground">
          Development mode — no email provider is configured, so no email was sent.
          {devLink ? (
            <>
              {" "}
              Use this link:{" "}
              <Link href={devLink} className="text-primary underline">
                {devLink}
              </Link>
            </>
          ) : (
            " No account exists for that address."
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-center">
        <h1 className="font-heading text-2xl">Reset your password</h1>
        <p className="text-sm text-muted-foreground">
          Enter your email to get a password reset link (development mode only — no emails are sent).
        </p>
      </div>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" placeholder="you@example.com" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? "Working…" : "Get reset link"}
          </Button>
        </form>
      </Form>
    </div>
  );
}
