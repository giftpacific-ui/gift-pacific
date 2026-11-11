import { Check, XCircle, RefreshCcw } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { orderStatusLabel as STATUS_LABELS } from "@/lib/order-status";
import type { OrderStatus } from "@prisma/client";

const STEPS: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

const HALTED_STATUSES: OrderStatus[] = ["CANCELLED", "FAILED_DELIVERY"];
const REFUND_STATUSES: OrderStatus[] = ["REFUND_REQUESTED", "REFUNDED"];

export function OrderTrackingTimeline({
  currentStatus,
  events,
}: {
  currentStatus: OrderStatus;
  events: { status: OrderStatus; note: string | null; createdAt: Date }[];
}) {
  if (HALTED_STATUSES.includes(currentStatus)) {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <XCircle className="mt-0.5 size-4 shrink-0" />
        <div>
          This order was {STATUS_LABELS[currentStatus].toLowerCase()}.
          {events.at(-1)?.note && <p className="mt-1 text-foreground/80">{events.at(-1)?.note}</p>}
        </div>
      </div>
    );
  }

  if (REFUND_STATUSES.includes(currentStatus)) {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-border bg-secondary/50 p-4 text-sm">
        <RefreshCcw className="mt-0.5 size-4 shrink-0 text-primary" />
        <div>
          <p className="font-medium">{STATUS_LABELS[currentStatus]}</p>
          {events.at(-1)?.note && <p className="mt-1 text-muted-foreground">{events.at(-1)?.note}</p>}
        </div>
      </div>
    );
  }

  const currentIndex = STEPS.indexOf(currentStatus);
  const eventByStatus = new Map(events.map((e) => [e.status, e]));

  return (
    <ol className="space-y-0">
      {STEPS.map((step, index) => {
        const isComplete = index <= currentIndex;
        const event = eventByStatus.get(step);
        return (
          <li key={step} className="relative flex gap-4 pb-8 last:pb-0">
            {index < STEPS.length - 1 && (
              <span
                className={cn(
                  "absolute left-[15px] top-8 h-full w-0.5",
                  isComplete ? "bg-primary" : "bg-border",
                )}
              />
            )}
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-xs",
                isComplete
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground",
              )}
            >
              {isComplete ? <Check className="size-4" /> : index + 1}
            </span>
            <div>
              <p className={cn("text-sm font-medium", !isComplete && "text-muted-foreground")}>
                {STATUS_LABELS[step]}
              </p>
              {event && (
                <p className="text-xs text-muted-foreground">{formatDate(event.createdAt)}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
