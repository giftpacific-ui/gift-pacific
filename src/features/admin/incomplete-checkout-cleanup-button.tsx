"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { runIncompleteCheckoutCleanupAction } from "@/server/actions/admin-incomplete-checkout.actions";

export function CleanupButton() {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await runIncompleteCheckoutCleanupAction();
          (r.success ? toast.success : toast.error)(r.message);
          router.refresh();
        })
      }
    >
      {pending ? "Cleaning…" : "Run cleanup now"}
    </Button>
  );
}
