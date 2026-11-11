"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { deleteCouponAction } from "@/server/actions/admin-coupon.actions";

export function DeleteCouponButton({ couponId }: { couponId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleDelete() {
    if (!confirm("Delete this coupon?")) return;
    startTransition(async () => {
      const r = await deleteCouponAction(couponId);
      if (!r.success) toast.error(r.message);
      router.refresh();
    });
  }

  return (
    <button onClick={handleDelete} disabled={isPending} aria-label="Delete coupon">
      <Trash2 className="size-4 text-destructive" />
    </button>
  );
}
