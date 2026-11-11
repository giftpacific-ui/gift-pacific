"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateProfileAction } from "@/server/actions/account.actions";

type FormValues = { name: string; email: string; phone: string };

export function ProfileForm({ user }: { user: { name: string; email: string; phone: string | null } }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: { name: user.name, email: user.email, phone: user.phone ?? "" },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const result = await updateProfileAction({ name: values.name, phone: values.phone });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success("Profile updated");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Full name</Label>
        <Input id="name" {...register("name")} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" disabled {...register("email")} />
        <p className="text-xs text-muted-foreground">Email changes aren&apos;t supported yet — contact support.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" type="tel" {...register("phone")} />
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
