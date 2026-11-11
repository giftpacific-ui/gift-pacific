"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PackageCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  bookCourierAction,
  refreshCourierStatusAction,
} from "@/server/actions/admin-courier.actions";
import { formatDate } from "@/lib/utils";
import { isSafeHttpUrl } from "@/lib/url-safety";

export type CourierPanelData = {
  providerName: string | null;
  providerProblem: string | null;
  /** Configured, working couriers the admin may choose from (labels only). */
  providers: { key: string; label: string }[];
  defaultProvider: string | null;
  canRefresh: boolean;
  bookingStatus: "NOT_BOOKED" | "BOOKING" | "BOOKED" | "FAILED" | "UNCERTAIN" | "MANUAL";
  canBook: boolean;
  needsConfirmation: boolean;
  blockedReason: string | null;
  consignmentId: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  bookedAt: Date | string | null;
  lastStatus: string | null;
  lastEventAt: Date | string | null;
  lastError: string | null;
};

const STATUS_LABEL: Record<CourierPanelData["bookingStatus"], string> = {
  NOT_BOOKED: "Not booked",
  BOOKING: "Booking in progress",
  BOOKED: "Booked",
  FAILED: "Booking rejected",
  UNCERTAIN: "Booking unconfirmed",
  MANUAL: "Entered manually",
};

export function AdminCourierPanel({ orderId, data }: { orderId: string; data: CourierPanelData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmed, setConfirmed] = useState(false);
  const [chosen, setChosen] = useState<string>(data.defaultProvider ?? data.providers[0]?.key ?? "");
  const chosenLabel = data.providers.find((p) => p.key === chosen)?.label ?? data.providerName ?? "courier";

  function run(fn: () => Promise<{ success: boolean; message?: string; note?: string }>, done: string) {
    startTransition(async () => {
      const result = await fn();
      if (!result.success) toast.error(result.message ?? "Something went wrong.");
      else toast.success(result.note ?? done);
      setConfirmed(false);
      router.refresh();
    });
  }

  const bookLabel =
    data.bookingStatus === "FAILED" || data.bookingStatus === "UNCERTAIN" || data.needsConfirmation
      ? `Retry booking with ${chosenLabel}`
      : `Book with ${chosenLabel}`;

  return (
    <div className="bg-white border border-border/60 rounded-3xl p-6 shadow-xs space-y-4">
      <h3 className="font-heading text-base font-bold text-foreground flex items-center gap-2">
        <PackageCheck className="size-4 text-primary" /> Courier booking
      </h3>

      <div className="text-sm space-y-1">
        <p>
          <span className="text-muted-foreground">Status:</span>{" "}
          <span className="font-medium">{STATUS_LABEL[data.bookingStatus]}</span>
        </p>
        {data.consignmentId && (
          <p>
            <span className="text-muted-foreground">Consignment:</span>{" "}
            <span className="font-mono">{data.consignmentId}</span>
          </p>
        )}
        {data.trackingNumber && (
          <p>
            <span className="text-muted-foreground">Tracking:</span>{" "}
            {data.trackingUrl && isSafeHttpUrl(data.trackingUrl) ? (
              <a href={data.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                {data.trackingNumber}
              </a>
            ) : (
              <span className="font-mono">{data.trackingNumber}</span>
            )}
          </p>
        )}
        {data.bookedAt && (
          <p className="text-muted-foreground">Booked {formatDate(data.bookedAt)}</p>
        )}
        {data.lastStatus && (
          <p>
            <span className="text-muted-foreground">Courier status:</span>{" "}
            <span className="font-medium">{data.lastStatus.replaceAll("_", " ")}</span>
            {data.lastEventAt && (
              <span className="text-muted-foreground"> · {formatDate(data.lastEventAt)}</span>
            )}
          </p>
        )}
      </div>

      {data.lastError && (
        <p className="rounded-2xl bg-destructive/10 p-3 text-xs text-destructive">
          Last error: {data.lastError}
        </p>
      )}

      {data.providerProblem && (
        <p className="rounded-2xl bg-secondary/60 p-3 text-xs text-foreground/80">
          API booking is unavailable: {data.providerProblem} You can still enter the courier and
          tracking details manually below.
        </p>
      )}

      {data.canBook ? (
        <div className="space-y-3">
          {data.needsConfirmation && (
            <label className="flex items-start gap-2 text-xs text-foreground/80">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                I checked the courier portal and this order does <strong>not</strong> already have a
                consignment. {data.blockedReason}
              </span>
            </label>
          )}
          {data.providers.length > 1 && (
            <label className="block text-xs text-muted-foreground">
              Courier
              <select value={chosen} onChange={(e) => setChosen(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
                {data.providers.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </label>
          )}
          <Button
            className="w-full rounded-full h-11 font-medium"
            disabled={isPending || (data.needsConfirmation && !confirmed)}
            onClick={() => run(() => bookCourierAction(orderId, confirmed, chosen || undefined), "Booked with the courier.")}
          >
            {isPending ? "Working…" : bookLabel}
          </Button>
        </div>
      ) : (
        data.blockedReason &&
        data.bookingStatus !== "BOOKED" && (
          <p className="text-xs text-muted-foreground">{data.blockedReason}</p>
        )
      )}

      {data.canRefresh && (
        <Button
          variant="outline"
          className="w-full rounded-full h-11 border-border/60 font-medium"
          disabled={isPending}
          onClick={() => run(() => refreshCourierStatusAction(orderId), "Courier status refreshed.")}
        >
          <RefreshCw className="mr-2 size-4" /> Refresh courier status
        </Button>
      )}

      {data.bookingStatus === "BOOKED" && (
        <p className="text-xs text-muted-foreground">
          Cancelling this order does not cancel the consignment — cancel it in the courier&apos;s
          portal as well. Booking never changes the order status or stock.
        </p>
      )}
    </div>
  );
}
