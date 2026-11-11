"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { toggleCustomerActiveAction } from "@/server/actions/admin-customer.actions";

export function ToggleCustomerActiveButton({ userId, isActive }: { userId: string; isActive: boolean }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleToggle() {
    startTransition(async () => {
      const result = await toggleCustomerActiveAction(userId, !isActive);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(isActive ? "Account disabled" : "Account re-enabled");
      router.refresh();
    });
  }

  return (
    <Button variant={isActive ? "destructive" : "outline"} onClick={handleToggle} disabled={isPending}>
      {isActive ? "Disable account" : "Re-enable account"}
    </Button>
  );
}
