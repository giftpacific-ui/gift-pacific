"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { deleteBannerAction } from "@/server/actions/admin-settings.actions";

export function DeleteBannerButton({ bannerId }: { bannerId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleDelete() {
    if (!confirm("Delete this banner?")) return;
    startTransition(async () => {
      const r = await deleteBannerAction(bannerId);
      if (!r.success) toast.error(r.message);
      router.refresh();
    });
  }

  return (
    <button onClick={handleDelete} disabled={isPending} aria-label="Delete banner">
      <Trash2 className="size-4 text-destructive" />
    </button>
  );
}
