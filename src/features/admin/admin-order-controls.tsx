"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  updateOrderStatusAction,
  updateOrderTrackingAction,
  updatePaymentStatusAction,
  updateOrderAdminNoteAction,
  approveRefundAction,
  rejectRefundAction,
} from "@/server/actions/admin-order.actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Order, OrderStatus, PaymentStatus } from "@prisma/client";
import { RefreshCw, CreditCard, Truck, FileText, Undo2 } from "lucide-react";

import { allowedNextStatuses } from "@/lib/order-transitions";
const PAYMENT_STATUSES: PaymentStatus[] = [
  "UNPAID",
  "PENDING",
  "PAID",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
];

type OrderWithEvents = Order & {
  courierBookingStatus?: string;
  trackingEvents: {
    status: OrderStatus;
    note: string | null;
    createdAt: Date;
  }[];
};

export function AdminOrderControls({ order }: { order: OrderWithEvents }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const nextStatuses = allowedNextStatuses(order.status);
  const [status, setStatus] = useState<OrderStatus | "">(nextStatuses[0] ?? "");
  const [statusNote, setStatusNote] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>(
    order.paymentStatus,
  );
  // Details of an API-booked consignment can't be hand-edited.
  const courierLocked =
    order.courierBookingStatus === "BOOKED" || order.courierBookingStatus === "BOOKING";
  const [courierName, setCourierName] = useState(order.courierName ?? "");
  const [trackingNumber, setTrackingNumber] = useState(
    order.trackingNumber ?? "",
  );
  const [trackingUrl, setTrackingUrl] = useState(order.trackingUrl ?? "");
  const [adminNote, setAdminNote] = useState(order.adminNote ?? "");

  const refundReason = [...order.trackingEvents]
    .reverse()
    .find((e) => e.status === "REFUND_REQUESTED")?.note;

  function handleApproveRefund() {
    startTransition(() => {
      approveRefundAction(order.id)
        .then((result) => {
          if (!result.success) return toast.error(result.message);
          toast.success("Refund approved");
          router.refresh();
        })
        .catch(console.error);
    });
  }

  function handleRejectRefund() {
    startTransition(() => {
      rejectRefundAction(order.id, rejectNote || undefined)
        .then((result) => {
          if (!result.success) return toast.error(result.message);
          toast.success("Refund request rejected");
          setRejectNote("");
          router.refresh();
        })
        .catch(console.error);
    });
  }

  function handleStatusUpdate() {
    if (!status) return;
    startTransition(() => {
      updateOrderStatusAction(order.id, status, statusNote || undefined)
        .then((result) => {
          if (!result.success) return toast.error(result.message);
          toast.success("Order status updated");
          setStatusNote("");
          router.refresh();
        })
        .catch(console.error);
    });
  }

  function handlePaymentUpdate() {
    startTransition(() => {
      updatePaymentStatusAction(order.id, paymentStatus)
        .then((result) => {
          if (!result.success) return toast.error(result.message);
          toast.success("Payment status re-derived from verified records");
          router.refresh();
        })
        .catch(console.error);
    });
  }

  function handleTrackingUpdate() {
    startTransition(() => {
      updateOrderTrackingAction(order.id, {
        courierName,
        trackingNumber,
        trackingUrl,
      })
        .then((result) => {
          if (!result.success) return toast.error(result.message);
          toast.success("Tracking info updated");
          router.refresh();
        })
        .catch(console.error);
    });
  }

  function handleNoteUpdate() {
    startTransition(() => {
      updateOrderAdminNoteAction(order.id, adminNote)
        .then((result) => {
          if (!result.success) return toast.error(result.message);
          toast.success("Note saved");
          router.refresh();
        })
        .catch(console.error);
    });
  }

  return (
    <div className="space-y-6 sticky top-6">
      {order.status === "REFUND_REQUESTED" && (
        <div className="bg-white border border-primary/40 rounded-3xl p-6 shadow-xs space-y-4">
          <h3 className="font-heading text-base font-bold text-foreground flex items-center gap-2">
            <Undo2 className="size-4 text-primary" /> Refund Request
          </h3>
          {refundReason && (
            <p className="rounded-2xl bg-secondary/60 p-3 text-sm text-foreground/80">
              {refundReason}
            </p>
          )}
          <Input
            placeholder="Rejection note (optional)"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            className="h-11 rounded-2xl bg-white border-border/60 text-sm"
          />
          <div className="flex gap-3">
            <Button
              onClick={handleApproveRefund}
              disabled={isPending}
              className="flex-1 rounded-full h-11 font-medium"
            >
              Approve
            </Button>
            <Button
              onClick={handleRejectRefund}
              disabled={isPending}
              variant="outline"
              className="flex-1 rounded-full h-11 border-border/60 font-medium"
            >
              Reject
            </Button>
          </div>
        </div>
      )}

      <div className="bg-white border border-border/60 rounded-3xl p-6 shadow-xs space-y-4">
        <h3 className="font-heading text-base font-bold text-foreground flex items-center gap-2">
          <RefreshCw className="size-4 text-primary" /> Order Status
        </h3>
        <p className="text-xs text-muted-foreground">
          Current:{" "}
          <span className="font-medium">
            {order.status.replaceAll("_", " ")}
          </span>
        </p>
        {nextStatuses.length === 0 ? (
          <p className="rounded-2xl bg-secondary/60 p-3 text-sm text-foreground/80">
            This order is {order.status.toLowerCase()} and its status can no
            longer be changed.
          </p>
        ) : (
          <div className="space-y-3">
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as OrderStatus)}
            >
              <SelectTrigger className="w-full h-11 rounded-2xl bg-white border-border/60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-2xl">
                {nextStatuses.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="Status note (optional)"
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
              className="h-11 rounded-2xl bg-white border-border/60 text-sm"
            />
            <Button
              onClick={handleStatusUpdate}
              disabled={isPending}
              className="w-full rounded-full h-11 font-medium shadow-xs"
            >
              Update status
            </Button>
          </div>
        )}
      </div>

      <div className="bg-white border border-border/60 rounded-3xl p-6 shadow-xs space-y-4">
        <h3 className="font-heading text-base font-bold text-foreground flex items-center gap-2">
          <CreditCard className="size-4 text-primary" /> Payment Status
        </h3>
        <div className="space-y-3">
          {/* Derived from verified payments and recorded refunds: it cannot be typed in (a hand-set PAID would hide a partial payment). */}
          <Select value={paymentStatus} disabled onValueChange={(v) => setPaymentStatus(v as PaymentStatus)}>
            <SelectTrigger className="w-full h-11 rounded-2xl bg-white border-border/60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-2xl">
              {PAYMENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replaceAll("_", " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={handlePaymentUpdate}
            disabled={isPending}
            variant="outline"
            className="w-full rounded-full h-11 border-border/60 font-medium"
          >
            Recalculate from verified records
          </Button>
        </div>
      </div>

      <div className="bg-white border border-border/60 rounded-3xl p-6 shadow-xs space-y-4">
        <h3 className="font-heading text-base font-bold text-foreground flex items-center gap-2">
          <Truck className="size-4 text-primary" /> Manual courier entry
        </h3>
        {courierLocked && (
          <p className="text-xs text-muted-foreground">
            This order is booked through the courier API, so these details are read-only.
          </p>
        )}
        <div className="space-y-3">
          <Input
            placeholder="Courier name"
            disabled={courierLocked}
            value={courierName}
            onChange={(e) => setCourierName(e.target.value)}
            className="h-11 rounded-2xl bg-white border-border/60 text-sm"
          />
          <Input
            placeholder="Tracking number"
            disabled={courierLocked}
            value={trackingNumber}
            onChange={(e) => setTrackingNumber(e.target.value)}
            className="h-11 rounded-2xl bg-white border-border/60 text-sm"
          />
          <Input
            placeholder="Tracking URL"
            disabled={courierLocked}
            value={trackingUrl}
            onChange={(e) => setTrackingUrl(e.target.value)}
            className="h-11 rounded-2xl bg-white border-border/60 text-sm"
          />
          <Button
            onClick={handleTrackingUpdate}
            disabled={isPending || courierLocked}
            variant="outline"
            className="w-full rounded-full h-11 border-border/60 font-medium"
          >
            Save tracking info
          </Button>
        </div>
      </div>

      <div className="bg-white border border-border/60 rounded-3xl p-6 shadow-xs space-y-4">
        <h3 className="font-heading text-base font-bold text-foreground flex items-center gap-2">
          <FileText className="size-4 text-primary" /> Internal Note
        </h3>
        <div className="space-y-3">
          <Textarea
            value={adminNote}
            onChange={(e) => setAdminNote(e.target.value)}
            rows={3}
            placeholder="Add internal notes about this order..."
            className="rounded-2xl bg-white border-border/60 text-sm p-3 resize-none"
          />
          <Button
            onClick={handleNoteUpdate}
            disabled={isPending}
            variant="outline"
            className="w-full rounded-full h-11 border-border/60 font-medium"
          >
            Save note
          </Button>
        </div>
      </div>
    </div>
  );
}
