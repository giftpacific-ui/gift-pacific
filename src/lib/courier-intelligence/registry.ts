import type { IntelProviderKey, ProviderDescriptor } from "@/lib/courier-intelligence/types";

/**
 * What each courier's documentation lets us do. Steadfast last checked 2026-11-21, Pathao and REDX re-checked 2026-11-23 (web research only; no
 * real API call was ever made).
 *
 * PROMOTING a courier from `unsupported` to `supported` needs ALL of (nothing less, because a guessed field name silently becomes a wrong "success rate"):
 *   1. the courier's OWN published contract: the endpoint, the credentials it uses, AND the response fields (not a third-party wrapper's guess);
 *   2. a strict mapper in lib/courier-intelligence (unknown shape -> invalid_response, never a default) with tests built from that contract;
 *   3. an adapter in server/services/courier-intelligence-providers, registered in that folder's index (HISTORY_ADAPTER_FACTORIES);
 *   4. the descriptor flipped here, listing exactly the metrics that courier documents (the gate in verify.ts strips everything else).
 * A courier is independent of the others at every step: its adapter, mapper, credentials, budget, cache rows and failures are its own.
 */
export const PROVIDER_DESCRIPTORS: Record<IntelProviderKey, ProviderDescriptor> = {
  steadfast: {
    key: "steadfast",
    label: "Steadfast",
    capability: "supported",
    supportedMetrics: ["delivered", "cancelled", "total", "fraudReports"],
    unsupportedMetrics: ["returned", "failed", "deliveryRate", "cancellationRate"],
    verification: {
      state: "vendor_documented",
      source: "Steadfast's own published client package (Packagist steadfast-courier/steadfast-laravel-package 2.0.0, author it.woop@steadfast.com.bd), whose README lists GET /fraud_check/{phone} among the endpoints of the official Postman collection and shows its response. The Postman page itself could not be opened.",
      verifiedOn: "2026-11-21",
      liveTested: false,
    },
    summary: "Parcel counts for the number across Steadfast: total, delivered, cancelled, and a list of fraud reports (only its length is kept).",
    semantics: "\"Cancelled\" is Steadfast's own cancelled outcome. Steadfast reports no separate returned or failed count, no rate and no score.",
    endpoint: "GET {STEADFAST_API_BASE_URL}/fraud_check/{phone}",
  },
  pathao: {
    key: "pathao",
    label: "Pathao",
    capability: "unsupported",
    supportedMetrics: [],
    unsupportedMetrics: ["delivered", "cancelled", "returned", "failed", "total", "deliveryRate", "cancellationRate", "fraudReports"],
    verification: {
      state: "not_documented",
      source: "Re-checked 2026-11-23. Pathao's merchant API as documented by the community SDKs (token, cities/zones/areas, price, stores, orders) lists no customer history call. Two community wrappers (enan/pathao-courier, devrkb21/pathao-laravel) do list a 'user success rate by phone number' call (POST, merchant API credentials), and one plugin's service disclosure names POST /aladdin/api/v1/user/success-rate on api-hermes.pathao.com. None of these is published by Pathao, none shows the response fields, and Pathao's own developer page could not be read. Counts cannot be mapped without guessing field names, so it stays unsupported. The 'fraud checker' packages that return success/cancel counts for Pathao log in with a merchant PANEL email/password instead, which is not an API.",
      verifiedOn: "2026-11-23",
      liveTested: false,
    },
    summary: "Not available: no Pathao-published contract returns a customer's delivery history. Nothing is called and no result is invented.",
    semantics: "Not applicable (no lookup).",
    endpoint: null,
  },
  redx: {
    key: "redx",
    label: "REDX",
    capability: "unsupported",
    supportedMetrics: [],
    unsupportedMetrics: ["delivered", "cancelled", "returned", "failed", "total", "deliveryRate", "cancellationRate", "fraudReports"],
    verification: {
      state: "not_documented",
      source: "Re-checked 2026-11-23. The official REDX Open API (openapi.redx.com.bd v1.0.0-beta, redx.com.bd/developer-api: create parcel, track, parcel info, areas, pickup stores) has no customer history lookup. The call community fraud checkers use (a 'customer-success-return-rate' request on redx.com.bd/api/redx_se/admin) sits behind the merchant PANEL login, and those packages report that REDX now requires an OTP at login, so it cannot be automated. Panel scraping is not an API we use.",
      verifiedOn: "2026-11-23",
      liveTested: false,
    },
    summary: "Not available: the REDX Open API has no customer history lookup, and panel-login scraping is not an API we will use.",
    semantics: "Not applicable (no lookup).",
    endpoint: null,
  },
};

export const providerDescriptor = (k: IntelProviderKey): ProviderDescriptor => PROVIDER_DESCRIPTORS[k];

/** Couriers that have a history adapter (the `supported` descriptors). A test keeps this equal to the descriptors, so the two can never drift apart. */
export const KNOWN_FRAUD_PROVIDERS = ["steadfast"] as const;
