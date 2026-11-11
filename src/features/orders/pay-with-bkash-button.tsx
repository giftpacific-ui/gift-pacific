"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/utils";
import { startBkashPaymentAction } from "@/server/actions/gateway-payment.actions";

/** Sends the customer to bKash to approve the advance. Nothing is credited here: the order only updates after bKash confirms server-side. */
export function PayWithBkashButton({ orderNumber, amount }: { orderNumber: string; amount: number }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await startBkashPaymentAction(orderNumber);
          if (!result.success) return void toast.error(result.message);
          window.location.assign(result.redirectUrl);
        })
      }
    >
      {pending ? "Opening bKash…" : `Pay ${formatPrice(amount)} with bKash`}
    </Button>
  );
}
