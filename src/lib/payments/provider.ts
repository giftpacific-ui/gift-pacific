/**
 * ISOLATED INTEGRATION BOUNDARY for online wallet payments (bKash / Nagad merchant APIs).
 *
 * No provider adapter exists in this codebase ON PURPOSE: the official merchant API contracts (endpoints, authentication, payload and
 * callback formats, verification/query calls, sandbox behaviour) were not available when this was written, and inventing them would risk
 * marking orders as paid on false evidence. Until an adapter is written from the providers' current official documentation:
 *   - checkout offers cash on delivery plus the MANUAL advance flow (customer claim -> staff verification, see advance.service.ts);
 *   - nothing here ever reports a payment as successful.
 *
 * Contract a future adapter must honour (enforced by the callers, not by this file):
 *   1. `createPayment` returns a provider reference + redirect URL; the order amount/currency come from the SERVER, never the browser.
 *   2. A browser return/callback is NOT proof of payment. `verifyPayment` must call the provider's documented verification API and compare
 *      amount, currency, order reference and transaction id before anything is recorded.
 *   3. Recording goes through the existing Payment model (kind ADVANCE or FULL) with `(method, providerRef)` UNIQUE (replay protection) and
 *      the same conditional-update idempotency as `verifyAdvancePayment`.
 *   4. Timeouts/unknown results are `uncertain` and must be reconciled by querying the provider; never mark them failed or paid blindly.
 *   5. Secrets are read from environment variables on the server only, never logged, and no wallet PIN/OTP is ever stored.
 */
export type ProviderPaymentRequest = { orderId: string; orderNumber: string; amount: number; currency: "BDT"; returnUrl: string };
export type ProviderPaymentStart = { providerRef: string; redirectUrl: string };
export type ProviderVerification =
  | { status: "paid"; providerRef: string; amount: number; currency: string; transactionId: string }
  | { status: "failed" | "cancelled" }
  | { status: "uncertain"; reason: string };

export interface WalletPaymentProvider {
  readonly key: "BKASH" | "NAGAD";
  createPayment(req: ProviderPaymentRequest): Promise<ProviderPaymentStart>;
  verifyPayment(providerRef: string): Promise<ProviderVerification>;
}

/** Registry of verified adapters. Intentionally empty until adapters are built from official documentation. */
const ADAPTERS: Partial<Record<"BKASH" | "NAGAD", () => WalletPaymentProvider | null>> = {};

export function getWalletProvider(key: "BKASH" | "NAGAD"): WalletPaymentProvider | null {
  return ADAPTERS[key]?.() ?? null;
}

/**
 * Admin-facing status of the wallet gateways. "adapterAvailable" is true only when a verified adapter is registered above;
 * until then nothing can initiate or confirm an online wallet payment, and the manual advance flow is the only wallet path.
 */
export function getWalletProviderStatus(): { key: "BKASH" | "NAGAD"; label: string; adapterAvailable: boolean }[] {
  return [
    { key: "BKASH", label: "bKash", adapterAvailable: getWalletProvider("BKASH") !== null },
    { key: "NAGAD", label: "Nagad", adapterAvailable: getWalletProvider("NAGAD") !== null },
  ];
}
