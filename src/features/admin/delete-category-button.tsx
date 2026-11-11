"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { deleteCategoryAction } from "@/server/actions/admin-category.actions";

export function DeleteCategoryButton({ categoryId }: { categoryId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleDelete() {
    if (!confirm("Delete this category? Products in it will become uncategorized.")) return;
    startTransition(async () => {
      const result = await deleteCategoryAction(categoryId);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <button onClick={handleDelete} disabled={isPending} aria-label="Delete category">
      <Trash2 className="size-4 text-destructive" />
    </button>
  );
}
