import "server-only";

/**
 * bKash Tokenized Checkout client (server only).
 *
 * SOURCE OF THE CONTRACT: the endpoint paths, the "0000" statusCode convention, mode "0011" for a one-shot payment, and the
 * sandbox/production hosts below come from the publicly documented bkash-rs client (which lists every endpoint it calls,
 * tested against bKash's sandbox). bKash's own developer portal was not retrievable when this was written, so this is NOT
 * "verified from official documentation" and has NOT been run against a real or sandbox merchant account. Before going live:
 * run one sandbox payment end to end and compare the request/response fields with the portal.
 *
 * Credentials come ONLY from environment variables, are read on the server, and are never logged or returned to a client.
 */

export type BkashEnvironment = "SANDBOX" | "PRODUCTION";

export type BkashConfig = {
  enabled: boolean;
  environment: BkashEnvironment;
  baseUrl: string;
  appKey: string | null;
  appSecret: string | null;
  username: string | null;
  password: string | null;
  timeoutMs: number;
  /** Admin-facing reason the integration cannot be used, or null when it is ready. Never contains a secret value. */
  problem: string | null;
  /** The environment variable NAMES that are still empty. */
  missing: string[];
};

const DEFAULT_BASE: Record<BkashEnvironment, string> = {
  SANDBOX: "https://tokenized.sandbox.bka.sh/v1.2.0-beta",
  PRODUCTION: "https://tokenized.pay.bka.sh/v1.2.0-beta",
};

type Env = Record<string, string | undefined>;
const clean = (v: string | undefined) => (v?.trim() ? v.trim() : null);

export function getBkashConfig(env: Env = process.env): BkashConfig {
  const environment: BkashEnvironment = clean(env.BKASH_ENV)?.toLowerCase() === "production" ? "PRODUCTION" : "SANDBOX";
  const override = clean(env.BKASH_BASE_URL);
  let baseUrl = DEFAULT_BASE[environment];
  let problem: string | null = null;
  if (override) {
    try {
      const u = new URL(override);
      if (u.protocol !== "https:") problem = "BKASH_BASE_URL must be an https URL.";
      else baseUrl = override.replace(/\/+$/, "");
    } catch {
      problem = "BKASH_BASE_URL is not a valid URL.";
    }
  }
  const appKey = clean(env.BKASH_APP_KEY);
  const appSecret = clean(env.BKASH_APP_SECRET);
  const username = clean(env.BKASH_USERNAME);
  const password = clean(env.BKASH_PASSWORD);
  const missing = [["BKASH_APP_KEY", appKey], ["BKASH_APP_SECRET", appSecret], ["BKASH_USERNAME", username], ["BKASH_PASSWORD", password]]
    .filter(([, v]) => !v)
    .map(([k]) => k as string);
  const enabled = clean(env.BKASH_ENABLED)?.toLowerCase() === "true";
  const timeout = Number(env.BKASH_TIMEOUT_MS);
  if (!problem && missing.length > 0) problem = `Missing: ${missing.join(", ")}.`;
  if (!problem && !enabled) problem = "Switched off (set BKASH_ENABLED=true to turn it on).";
  return { enabled, environment, baseUrl, appKey, appSecret, username, password, timeoutMs: Number.isFinite(timeout) && timeout >= 3000 && timeout <= 60000 ? timeout : 20000, problem, missing };
}

export const isBkashUsable = (c: BkashConfig) => c.problem === null;

export class BkashError extends Error {
  constructor(
    public readonly kind: "auth" | "api" | "timeout" | "network" | "invalid_response",
    message: string,
    public readonly code: string | null = null,
  ) {
    super(message);
  }
  /** The request may or may not have been processed by bKash (so the outcome must be QUERIED, never assumed). */
  get outcomeUnknown() {
    return this.kind === "timeout" || this.kind === "network" || this.kind === "invalid_response";
  }
}

type Token = { idToken: string; expiresAt: number };
let tokenCache: { key: string; token: Token } | null = null;

async function fetchJson(config: BkashConfig, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new BkashError("invalid_response", `bKash returned a non-JSON response (HTTP ${res.status}).`);
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new BkashError("invalid_response", "bKash returned an unexpected response.");
    return { status: res.status, json: json as Record<string, unknown> };
  } catch (error) {
    if (error instanceof BkashError) throw error;
    if ((error as { name?: string }).name === "AbortError") throw new BkashError("timeout", "bKash did not answer in time.");
    throw new BkashError("network", "Could not reach bKash.");
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(config: BkashConfig, force = false): Promise<string> {
  const key = `${config.baseUrl}|${config.appKey}`;
  if (!force && tokenCache && tokenCache.key === key && tokenCache.token.expiresAt - Date.now() > 60_000) return tokenCache.token.idToken;
  const { json } = await fetchJson(config, "/tokenized/checkout/token/grant", { username: config.username as string, password: config.password as string }, { app_key: config.appKey, app_secret: config.appSecret });
  const idToken = typeof json.id_token === "string" ? json.id_token : null;
  if (!idToken) {
    throw new BkashError("auth", `bKash did not issue a token${typeof json.statusMessage === "string" ? `: ${json.statusMessage}` : ""}.`, typeof json.statusCode === "string" ? json.statusCode : null);
  }
  const ttl = Number(json.expires_in);
  tokenCache = { key, token: { idToken, expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600) * 1000 } };
  return idToken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST with the id_token. `safeToRetry` is true ONLY for read-only calls (query/search/status): create, execute and refund
 * are never re-sent after a timeout, because bKash may already have processed them.
 */
async function call(config: BkashConfig, path: string, body: unknown, safeToRetry: boolean): Promise<Record<string, unknown>> {
  const attempts = safeToRetry ? 3 : 1;
  let lastError: BkashError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let token = await getToken(config);
      let { status, json } = await fetchJson(config, path, { Authorization: token, "X-APP-Key": config.appKey as string }, body);
      if (status === 401) {
        // An expired token means the call was NOT processed, so one refresh-and-resend is safe for any call.
        token = await getToken(config, true);
        ({ status, json } = await fetchJson(config, path, { Authorization: token, "X-APP-Key": config.appKey as string }, body));
      }
      const code = typeof json.statusCode === "string" ? json.statusCode : null;
      if (code !== null && code !== "0000") {
        const msg = typeof json.statusMessage === "string" ? json.statusMessage : "bKash rejected the request.";
        throw new BkashError("api", msg, code);
      }
      if (code === null && status >= 400) throw new BkashError("api", `bKash returned HTTP ${status}.`);
      return json;
    } catch (error) {
      lastError = error instanceof BkashError ? error : new BkashError("network", "Unexpected error calling bKash.");
      const retryable = safeToRetry && lastError.outcomeUnknown && attempt < attempts;
      if (!retryable) throw lastError;
      await sleep(400 * attempt);
    }
  }
  throw lastError ?? new BkashError("network", "bKash request failed.");
}

/** Provider payloads are stored for troubleshooting; the customer's phone number is dropped first. */
export function redactBkashPayload(json: Record<string, unknown>): Record<string, unknown> {
  const { customerMsisdn: _a, payerAccount: _b, ...rest } = json;
  void _a;
  void _b;
  return rest;
}

export type BkashPaymentState = {
  paymentId: string | null;
  trxId: string | null;
  transactionStatus: string | null;
  amount: string | null;
  currency: string | null;
  merchantInvoiceNumber: string | null;
  statusCode: string | null;
  statusMessage: string | null;
  raw: Record<string, unknown>;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

function toState(json: Record<string, unknown>): BkashPaymentState {
  return {
    paymentId: str(json.paymentID),
    trxId: str(json.trxID),
    transactionStatus: str(json.transactionStatus),
    amount: str(json.amount),
    currency: str(json.currency),
    merchantInvoiceNumber: str(json.merchantInvoiceNumber),
    statusCode: str(json.statusCode),
    statusMessage: str(json.statusMessage),
    raw: redactBkashPayload(json),
  };
}

export async function bkashCreatePayment(config: BkashConfig, input: { amount: number; merchantInvoiceNumber: string; callbackUrl: string; payerReference: string }) {
  const json = await call(
    config,
    "/tokenized/checkout/create",
    { mode: "0011", payerReference: input.payerReference, callbackURL: input.callbackUrl, amount: input.amount.toFixed(2), currency: "BDT", intent: "sale", merchantInvoiceNumber: input.merchantInvoiceNumber },
    false,
  );
  const state = toState(json);
  const bkashUrl = str(json.bkashURL);
  if (!state.paymentId || !bkashUrl || !/^https:\/\//i.test(bkashUrl)) throw new BkashError("invalid_response", "bKash did not return a payment id and redirect URL.");
  return { ...state, bkashUrl };
}

export async function bkashExecutePayment(config: BkashConfig, paymentId: string) {
  return toState(await call(config, "/tokenized/checkout/execute", { paymentID: paymentId }, false));
}

export async function bkashQueryPayment(config: BkashConfig, paymentId: string) {
  return toState(await call(config, "/tokenized/checkout/payment/status", { paymentID: paymentId }, true));
}

export async function bkashSearchTransaction(config: BkashConfig, trxId: string) {
  return toState(await call(config, "/tokenized/checkout/general/searchTransaction", { trxID: trxId }, true));
}

export type BkashRefundState = { refundTrxId: string | null; transactionStatus: string | null; amount: string | null; statusCode: string | null; raw: Record<string, unknown> };

const toRefund = (json: Record<string, unknown>): BkashRefundState => ({
  refundTrxId: str(json.refundTrxID),
  transactionStatus: str(json.transactionStatus),
  amount: str(json.amount),
  statusCode: str(json.statusCode),
  raw: redactBkashPayload(json),
});

export async function bkashRefund(config: BkashConfig, input: { paymentId: string; trxId: string; amount: number; sku: string; reason: string }) {
  return toRefund(await call(config, "/tokenized/checkout/payment/refund", { paymentID: input.paymentId, trxID: input.trxId, amount: input.amount.toFixed(2), sku: input.sku, reason: input.reason }, false));
}

export async function bkashRefundStatus(config: BkashConfig, input: { paymentId: string; trxId: string }) {
  return toRefund(await call(config, "/tokenized/checkout/payment/refund/status", { paymentID: input.paymentId, trxID: input.trxId }, true));
}

/** Validates the credentials by asking bKash for a token (no money moves). Used by the admin "Test connection" button. */
export async function bkashTestConnection(config: BkashConfig): Promise<void> {
  await getToken(config, true);
}
