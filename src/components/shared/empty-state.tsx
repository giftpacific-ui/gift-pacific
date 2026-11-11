import type { ReactNode } from "react";
import { PackageOpen } from "lucide-react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[4px] border border-dashed border-border bg-card/50 px-6 py-20 text-center">
      <PackageOpen className="size-10 text-muted-foreground/60" aria-hidden />
      <h2 className="font-heading text-2xl font-semibold">{title}</h2>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}
