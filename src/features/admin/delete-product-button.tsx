"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteProductAction } from "@/server/actions/admin-product.actions";

export function DeleteProductButton({ productId, productName }: { productId: string; productName: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleDelete() {
    if (!confirm(`Delete "${productName}"? This cannot be undone.`)) return;
    startTransition(async () => {
      const result = await deleteProductAction(productId);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success("Product deleted");
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={isPending}
      aria-label={`Delete ${productName}`}
      title="Delete product"
      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
    >
      <Trash2 className="size-4" />
    </button>
  );
}
