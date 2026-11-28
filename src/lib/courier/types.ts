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
      /** The COD amount the provider says it recorded for this consignment (echo of what we sent), when it returns one. */
      codAmount?: number | null;
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

/** Read-only credential/connectivity probe. Never creates anything and never carries account figures or secrets. */
export type CourierConnectionResult =
  | { ok: true }
  | { ok: false; kind: "auth" | "unreachable" | "unexpected"; message: string };

/**
 * Answer to "does the provider already hold a parcel for our reference?" (used to settle an UNCERTAIN booking).
 *  found   — the provider positively answered with a status for that reference: a parcel EXISTS. A second booking would duplicate it.
 *  unknown — anything else (not-found shaped replies, errors, timeouts, unreadable bodies). NEVER read as "absent": a provider's
 *            not-found reply shape is not documented, so absence is never inferred.
 */
export type CourierLookupResult = { kind: "found"; status: string } | { kind: "unknown"; message: string };

/** Neutral delivery events every provider status is mapped onto. */
export type CourierEvent =
  | "PENDING"
  | "PICKED_UP"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  /** Part of the parcel was delivered: never auto-completes the order; an admin must review items and cash. */
  | "PARTIAL_DELIVERED"
  | "DELIVERY_FAILED"
  | "RETURNED"
  /** The provider cancelled the consignment (the verified Steadfast vocabulary cannot distinguish a return from a pre-pickup cancellation). */
  | "CANCELLED"
  | "UNKNOWN";

export type ParsedWebhook = {
  consignmentId: string | null;
  /** Our reference (order number) if the provider echoes it back. */
  reference: string | null;
  status: string;
  /** The provider's own event time, ONLY when it carries an explicit time zone (a zone-less time is ambiguous and is dropped). */
  providerEventAt?: Date | null;
  /** COD amount the notification carries for the consignment. A consignment figure, NOT proof that cash was collected. */
  codAmount?: number | null;
};

/** ignored = authentic but not a delivery-status notification we act on; malformed = the body cannot be a valid notification. */
export type WebhookInspection =
  | { kind: "event"; event: ParsedWebhook }
  | { kind: "ignored" }
  | { kind: "malformed"; reason: string };

/** What an adapter can genuinely do (never claimed without an implementation). */
export type ProviderFeatures = {
  /** Provider pushes status notifications to us. */
  webhook: boolean;
  /** Status can be polled per consignment. */
  statusPolling: boolean;
  /** A read-only credential check exists. */
  connectionCheck: boolean;
  /** An existing parcel can be looked up by our reference (enabled explicitly; see config). */
  referenceLookup: boolean;
};

export interface CourierProvider {
  readonly key: string;
  readonly displayName: string;
  readonly features?: ProviderFeatures;
  book(request: CourierBookingRequest): Promise<CourierBookingResult>;
  /** Optional: providers without a status endpoint rely on webhooks/manual updates. */
  fetchStatus?(consignmentId: string): Promise<CourierStatusResult>;
  /** Optional: read-only credential/connectivity check for admin diagnostics. */
  checkConnection?(): Promise<CourierConnectionResult>;
  /** Optional: settle an UNCERTAIN booking by asking the provider about our reference. Never books. */
  lookupByReference?(reference: string): Promise<CourierLookupResult>;
  parseWebhook(body: unknown): ParsedWebhook | null;
  /** Optional richer webhook validation (distinguishes malformed from ignored). Falls back to parseWebhook. */
  inspectWebhook?(body: unknown): WebhookInspection;
  mapStatus(rawStatus: string): CourierEvent;
  /**
   * Optional progress rank of a raw status (higher = further along). Used only to stop an older/lower status
   * from overwriting a newer/higher one when no provider timestamp is available. Unknown statuses return null.
   */
  statusRank?(rawStatus: string): number | null;
  /** Optional: the raw status is final (no further provider movement expected), so polling can stop. */
  isFinalStatus?(rawStatus: string): boolean;
}
