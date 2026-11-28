"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { PackageCheck, RefreshCw, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  bookCourierAction,
  recoverUncertainBookingAction,
  refreshCourierStatusAction,
} from "@/server/actions/admin-courier.actions";
import { formatDate } from "@/lib/utils";
import { isSafeHttpUrl } from "@/lib/url-safety";
import { courierPickerOptions, initialPickerValue } from "@/lib/courier/provider-picker";
import type { CourierChoiceView } from "@/lib/courier/provider-state";
import type { TimelineEntry } from "@/lib/courier/timeline";
import { CourierTimeline } from "@/features/admin/courier-timeline";

export type CourierPanelData = {
  providerName: string | null;
  providerProblem: string | null;
  /** Steadfast, Pathao and RedX with their honest state (labels and flags only). Couriers without an adapter are listed but not selectable. */
  choices: CourierChoiceView[];
  /** What "Automatic" means right now: the default courier's key (null = none available) and why. */
  automatic: { key: string | null; message: string };
  defaultProvider: string | null;
  /** The courier this order was booked or hand-entered with. */
  orderProvider: string | null;
  /** A booking started but never finished: the courier may or may not hold a parcel. */
  staleBooking: boolean;
  canRefresh: boolean;
  /** The courier can be asked whether it already holds a parcel for an unconfirmed booking. */
  canRecover: boolean;
  bookingStatus: "NOT_BOOKED" | "BOOKING" | "BOOKED" | "FAILED" | "UNCERTAIN" | "MANUAL";
  canBook: boolean;
  needsConfirmation: boolean;
  blockedReason: string | null;
  /** EVERY reason the order cannot be booked now (soft = an admin can clear it by confirming). */
  blockers: { code: string; message: string; soft: boolean }[];
  /** What a booking would send, for review before the one-click action. */
  preview: { name: string; phone: string; address: string; codAmount: number } | null;
  consignmentId: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  bookedAt: Date | string | null;
  lastStatus: string | null;
  lastEventAt: Date | string | null;
  lastError: string | null;
  lastSyncAt: Date | string | null;
  remoteConfirmedAt: Date | string | null;
  courierCodAmount: number | null;
  timeline: (Omit<TimelineEntry, "at"> & { at: Date | string })[];
  cod: { status: string; label: string; expected: number; openFlags: { code: string; label: string; amount: number }[]; paymentRecorded: boolean } | null;
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
  // Automatic is the starting choice, so the configured default courier is never silently overridden by the first one in a list.
  const options = courierPickerOptions(data.choices, data.automatic);
  const [chosen, setChosen] = useState<string>(initialPickerValue(options));
  const automaticLabel = data.choices.find((c) => c.key === data.automatic.key)?.label ?? data.providerName ?? "courier";
  const chosenLabel = chosen === "" ? automaticLabel : (data.choices.find((c) => c.key === chosen)?.label ?? "courier");
  const bookableCount = options.filter((o) => !o.disabled).length;
  const orderProviderLabel = data.orderProvider ? (data.choices.find((c) => c.key === data.orderProvider)?.label ?? data.orderProvider) : null;

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
        {(orderProviderLabel ?? data.courierName) && (
          <p>
            <span className="text-muted-foreground">Courier:</span>{" "}
            <span className="font-medium">{orderProviderLabel ?? data.courierName}</span>
            {orderProviderLabel && data.courierName && data.courierName !== orderProviderLabel && <span className="text-muted-foreground"> ({data.courierName})</span>}
          </p>
        )}
        {data.consignmentId && (
          <p>
            <span className="text-muted-foreground">Consignment:</span>{" "}
            <span className="font-mono">{data.consignmentId}</span>
          </p>
        )}
        {data.trackingNumber && (
          <p>
            <span className="text-muted-foreground">Tracking:</span>{" "}
            <span className="font-mono">{data.trackingNumber}</span>
          </p>
        )}
        {data.trackingUrl && isSafeHttpUrl(data.trackingUrl) && (
          <p>
            <a href={data.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
              Track Parcel
            </a>
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
        {(data.bookingStatus === "BOOKED" || data.lastSyncAt) && (
          <p className="text-muted-foreground">
            Last synchronised: {data.lastSyncAt ? formatDate(data.lastSyncAt) : "not yet (waiting for the courier's first update)"}
          </p>
        )}
        {data.courierCodAmount !== null && (
          <p>
            <span className="text-muted-foreground">COD amount at courier:</span>{" "}
            <span className="font-medium">৳{data.courierCodAmount}</span>
          </p>
        )}
      </div>

      {data.staleBooking && (
        <p className="rounded-2xl bg-amber-50 p-3 text-xs text-amber-900">
          A booking was started but never finished, so the courier may or may not hold a parcel for this order. Check the courier portal first. Booking again
          is only possible after you confirm that, and only with the same courier.
        </p>
      )}

      {data.remoteConfirmedAt && data.bookingStatus === "UNCERTAIN" && (
        <p className="rounded-2xl bg-amber-50 p-3 text-xs text-amber-900">
          The courier has confirmed it already holds a parcel for this order, so booking again is blocked. Wait for its next status update (it will
          fill in the details), or enter the consignment and tracking details by hand below.
        </p>
      )}

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
          {data.preview && (
            <dl className="rounded-2xl border border-border/60 p-3 text-xs space-y-1">
              <dt className="font-medium text-foreground">Review before booking</dt>
              <dd>{data.preview.name} · {data.preview.phone}</dd>
              <dd className="text-muted-foreground">{data.preview.address}</dd>
              <dd>Cash to collect: <span className="font-semibold">৳{data.preview.codAmount}</span></dd>
            </dl>
          )}
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
          <label className="block text-xs text-muted-foreground">
            Courier
            <select value={chosen} onChange={(e) => setChosen(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
              {options.map((o) => <option key={o.value || "auto"} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </select>
          </label>
          {chosen === "" && <p className="text-xs text-muted-foreground">{data.automatic.message}</p>}
          {bookableCount === 0 && (
            <p className="rounded-2xl bg-secondary/60 p-3 text-xs text-foreground/80">
              No courier can be booked through its API right now. Record the parcel with the Manual courier entry below (Pathao and RedX are recorded by hand).
            </p>
          )}
          <Button
            className="w-full rounded-full h-11 font-medium"
            disabled={isPending || bookableCount === 0 || (data.needsConfirmation && !confirmed)}
            onClick={() => run(() => bookCourierAction(orderId, confirmed, chosen || undefined), "Booked with the courier.")}
          >
            {isPending ? "Working…" : bookLabel}
          </Button>
        </div>
      ) : (
        data.bookingStatus !== "BOOKED" &&
        data.blockers.length > 0 && (
          <div className="rounded-2xl bg-secondary/60 p-3 text-xs text-foreground/80 space-y-1">
            <p className="font-medium">This order cannot be booked yet:</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {data.blockers.map((b) => <li key={b.code}>{b.message}</li>)}
            </ul>
          </div>
        )
      )}

      {data.canRecover && (
        <Button
          variant="outline"
          className="w-full rounded-full h-11 border-border/60 font-medium"
          disabled={isPending}
          onClick={() => run(() => recoverUncertainBookingAction(orderId), "Checked with the courier.")}
        >
          <SearchCheck className="mr-2 size-4" /> Check with the courier
        </Button>
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

      {data.cod && (data.cod.status !== "NOT_DUE" || data.cod.openFlags.length > 0) && (
        <div className="rounded-2xl border border-border/60 p-3 text-xs space-y-1">
          <p>
            <span className="text-muted-foreground">COD reconciliation:</span> <span className="font-medium">{data.cod.label}</span>
            {" · "}
            <Link href="/admin/courier/cod" className="text-primary underline">review</Link>
          </p>
          {data.cod.openFlags.map((f) => (
            <p key={f.code} className="text-destructive">{f.label}{f.amount > 0 ? ` · ৳${f.amount}` : ""}</p>
          ))}
          <p className="text-muted-foreground">
            A courier saying &quot;delivered&quot; never marks the order paid: the cash is confirmed separately.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-foreground">Shipment timeline</h4>
        <CourierTimeline entries={data.timeline} />
      </div>

      {data.bookingStatus === "BOOKED" && (
        <p className="text-xs text-muted-foreground">
          Cancelling this order does not cancel the consignment — cancel it in the courier&apos;s
          portal as well. Booking never changes the order status or stock.
        </p>
      )}
    </div>
  );
}
