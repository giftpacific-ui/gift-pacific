/**
 * Courier provider contract. A provider adapter turns our neutral booking
 * request into that courier's API call and normalizes its answer. Adapters
 * live in this folder; the rest of the app only talks to this interface.
 */

export type CourierBookingRequest = {
  /** Our order number — also sent as the provider's invoice/reference. */
  reference: string;
  recipientName: string;
  /** Local 11-digit Bangladeshi mobile number, e.g. 01711000000. */
  recipientPhone: string;
  recipientAddress: string;
  /** Cash the courier must collect (0 for already-paid orders). */
  codAmount: number;
  itemDescription?: string;
  note?: string;
};

export type CourierBookingResult =
  | {
      ok: true;
      consignmentId: string;
      trackingCode: string | null;
      /** Only when the provider returns one — we never invent tracking URLs. */
      trackingUrl: string | null;
      providerStatus: string | null;
    }
  | {
      ok: false;
      /**
       * rejected  — the provider definitely did NOT create a consignment
       *             (validation/auth error): safe to retry after fixing.
       * uncertain — timeout / 5xx / unreadable reply: it MAY have been
       *             created, so a retry could duplicate it.
       */
      kind: "rejected" | "uncertain";
      message: string;
    };

export type CourierStatusResult =
  | { ok: true; status: string }
  | { ok: false; message: string };

/** Neutral delivery events every provider status is mapped onto. */
export type CourierEvent =
  | "PENDING"
  | "PICKED_UP"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "DELIVERY_FAILED"
  | "RETURNED"
  | "UNKNOWN";

export type ParsedWebhook = {
  consignmentId: string | null;
  /** Our reference (order number) if the provider echoes it back. */
  reference: string | null;
  status: string;
};

export interface CourierProvider {
  readonly key: string;
  readonly displayName: string;
  book(request: CourierBookingRequest): Promise<CourierBookingResult>;
  /** Optional: providers without a status endpoint rely on webhooks/manual updates. */
  fetchStatus?(consignmentId: string): Promise<CourierStatusResult>;
  parseWebhook(body: unknown): ParsedWebhook | null;
  mapStatus(rawStatus: string): CourierEvent;
}
