import "server-only";
import { createHash } from "node:crypto";
import { logServerWarning } from "@/lib/logger";
import { normalizeBdPhone, type FraudCheckHistory, type FraudCheckOutcome } from "@/lib/advance-policy";
import { FraudCheckProviderError, isValidFraudHistory } from "@/lib/fraud-check";
import { createSteadfastFraudProvider } from "@/server/services/fraud-providers/steadfast";

/**
 * Fraud check: asks a configured provider how many parcels to this phone number were delivered / cancelled / returned across the courier network.
 *
 * PROVIDERS: `steadfast` (src/server/services/fraud-providers/steadfast.ts) is the only adapter. It reuses the existing Steadfast courier credentials
 * (STEADFAST_API_KEY / STEADFAST_API_SECRET / STEADFAST_API_BASE_URL) and the endpoint GET /fraud_check/score/{phone}; it maps ONLY exact parcel
 * counts and never estimates a count from a percentage or a volume band (see HANDOFF_GIFTPACIFIC.md §17). Its response fields have NOT been
 * checked against the official guide in this repository: that is listed as the first open item. Without FRAUD_CHECK_PROVIDER=steadfast and the
 * Steadfast credentials every lookup is `unavailable (no_provider)`: score 50, standard advance, staff review. The application never pretends a
 * check happened.
 *
 * Reliability rules (fail-safe, never fail-open):
 *  - a missing/disabled provider, a bad phone, a timeout, an error, a malformed answer or an exhausted call budget all return `unavailable`;
 *    the checkout is never blocked, and a failure can never raise trust or lower the advance;
 *  - results are cached for FRAUD_CHECK_CACHE_SECONDS (default 10 minutes, hard maximum 24 hours: a result is never served indefinitely);
 *    transient failures are remembered for at most 30 seconds (and never longer than the cache time; cache time 0 = nothing is remembered);
 *  - concurrent lookups for the same phone share ONE provider call;
 *  - a per-minute call budget protects the provider's quota and cost from floods;
 *  - phone numbers and credentials are never logged; cache keys are hashes.
 */
export interface FraudCheckConfig {
  /** FRAUD_CHECK_API_KEY. The adapter decides what it means (the steadfast adapter ignores it and reuses the courier credentials). Server-side only. */
  apiKey: string | null;
  /** FRAUD_CHECK_API_BASE_URL (optional override). */
  baseUrl: string | null;
  timeoutMs: number;
}

export interface FraudCheckProvider {
  readonly key: string;
  /**
   * `phone` is normalised to 01XXXXXXXXX. Return DISTINCT-parcel counts (use `aggregateParcels` with the provider's OFFICIAL status mapping).
   * Throw when the answer is not certain. Never return guessed or partial data.
   */
  check(phone: string, signal: AbortSignal): Promise<FraudCheckHistory>;
}

/** Registered provider adapters, keyed by the FRAUD_CHECK_PROVIDER value. Must contain exactly KNOWN_FRAUD_PROVIDERS (a test keeps them equal). */
const PROVIDERS: Record<string, (config: FraudCheckConfig) => FraudCheckProvider | null> = {
  steadfast: createSteadfastFraudProvider,
};

/** Names of the registered adapters (for tests and diagnostics). */
export function registeredFraudProviders(): string[] {
  return Object.keys(PROVIDERS).sort();
}

/** A lookup result plus when it was obtained and whether it came from the cache. */
export type FraudLookup = FraudCheckOutcome & { checkedAt: string; cached: boolean };

/** `provider` = a real provider answered (even "no history"); `fallback` = the safe default policy was used. */
export function fraudSource(o: FraudCheckOutcome): "provider" | "fallback" {
  return o.status === "unavailable" ? "fallback" : "provider";
}

// ---- configuration ------------------------------------------------------------------------------------------------------------------------
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function fraudCheckSettings() {
  return {
    enabled: (process.env.FRAUD_CHECK_ENABLED ?? "true").trim().toLowerCase() !== "false",
    providerKey: (process.env.FRAUD_CHECK_PROVIDER ?? "").trim().toLowerCase(),
    apiKey: process.env.FRAUD_CHECK_API_KEY?.trim() || null,
    baseUrl: process.env.FRAUD_CHECK_API_BASE_URL?.trim() || null,
    timeoutMs: intEnv("FRAUD_CHECK_TIMEOUT_MS", 3000, 500, 10_000),
    cacheSeconds: intEnv("FRAUD_CHECK_CACHE_SECONDS", 600, 0, 86_400),
    maxCallsPerMinute: intEnv("FRAUD_CHECK_MAX_CALLS_PER_MINUTE", 60, 1, 1000),
  };
}

// ---- test seams (ignored in production) -----------------------------------------------------------------------------------------------------
let testProvider: FraudCheckProvider | null | undefined;
let nowFn: () => number = () => Date.now();

/** Test seam only: lets tests supply a provider stand-in. Ignored in production. */
export function setFraudCheckProviderForTests(p: FraudCheckProvider | null | undefined) {
  if (process.env.NODE_ENV === "production") return;
  testProvider = p;
}
/** Test seam only: a controllable clock for cache-expiry tests. Ignored in production. */
export function setFraudCheckClockForTests(fn: (() => number) | undefined) {
  if (process.env.NODE_ENV === "production") return;
  nowFn = fn ?? (() => Date.now());
}
/** Test seam only: forgets cached results, in-flight lookups and the call budget. Ignored in production. */
export function resetFraudCheckStateForTests() {
  if (process.env.NODE_ENV === "production") return;
  cache.clear();
  inflight.clear();
  calls.length = 0;
}

function activeProvider(s: ReturnType<typeof fraudCheckSettings>): FraudCheckProvider | null {
  if (testProvider !== undefined && process.env.NODE_ENV !== "production") return testProvider;
  if (!s.providerKey || s.providerKey === "none") return null;
  // Own properties only: a value such as "constructor" or "__proto__" must never resolve to something inherited from Object.prototype.
  const make = Object.prototype.hasOwnProperty.call(PROVIDERS, s.providerKey) ? PROVIDERS[s.providerKey] : undefined;
  if (!make) {
    logServerWarning("fraud-check", "FRAUD_CHECK_PROVIDER is set to a provider that has no adapter; fraud check is disabled", { provider: s.providerKey.slice(0, 30) });
    return null;
  }
  return make({ apiKey: s.apiKey, baseUrl: s.baseUrl, timeoutMs: s.timeoutMs });
}

/** Admin-facing status. Never includes the credentials themselves. */
export function fraudCheckStatus(): {
  enabled: boolean;
  configured: boolean;
  provider: string | null;
  hasCredentials: boolean;
  /** Names of the variables the credentials come from (never their values). */
  credentialSource: string | null;
  timeoutMs: number;
  cacheSeconds: number;
  maxCallsPerMinute: number;
} {
  const s = fraudCheckSettings();
  const p = s.enabled ? activeProvider(s) : null;
  // A provider is only built when its credentials exist, so "configured" implies credentials are present.
  const credentialSource = p?.key === "steadfast" ? "STEADFAST_API_KEY / STEADFAST_API_SECRET (shared with courier booking)" : p ? "FRAUD_CHECK_API_KEY" : null;
  return { enabled: s.enabled, configured: p !== null, provider: p?.key ?? null, hasCredentials: p !== null || s.apiKey !== null, credentialSource, timeoutMs: s.timeoutMs, cacheSeconds: s.cacheSeconds, maxCallsPerMinute: s.maxCallsPerMinute };
}

/**
 * There is NO verified-phone mechanism in this project (no OTP; the account phone is a free-text profile field). Until one is built and tested,
 * delivered history earns no trust. Do not make this return true for a profile phone.
 */
export function isPhoneVerified(): boolean {
  if (phoneVerifiedForTests !== undefined && process.env.NODE_ENV !== "production") return phoneVerifiedForTests;
  return false;
}
let phoneVerifiedForTests: boolean | undefined;
/** Test seam only: simulates a FUTURE verified-phone mechanism so the verified path of the scoring can be exercised. Ignored in production. */
export function setPhoneVerifiedForTests(v: boolean | undefined) {
  if (process.env.NODE_ENV === "production") return;
  phoneVerifiedForTests = v;
}

// ---- cache, de-duplication, call budget -------------------------------------------------------------------------------------------------------
const MAX_CACHE_ENTRIES = 1000;
const FAILURE_TTL_MS = 30_000;
const cache = new Map<string, { value: FraudLookup; expiresAt: number }>();
const inflight = new Map<string, Promise<FraudLookup>>();
const calls: number[] = [];

const cacheKey = (provider: string, phone: string) => createHash("sha256").update(`${provider}|${phone}`).digest("hex");

function remember(key: string, value: FraudLookup, ttlMs: number) {
  if (ttlMs <= 0) return;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key); // re-insert so the newest entry is last
  cache.set(key, { value, expiresAt: nowFn() + ttlMs });
}

/** Counts one provider call against the per-minute budget; false when the budget is used up. */
function takeBudget(limit: number): boolean {
  const now = nowFn();
  while (calls.length > 0 && now - calls[0] >= 60_000) calls.shift();
  if (calls.length >= limit) return false;
  calls.push(now);
  return true;
}

const unavailable = (reason: Extract<FraudCheckOutcome, { status: "unavailable" }>["reason"]): FraudLookup => ({ status: "unavailable", reason, checkedAt: new Date(nowFn()).toISOString(), cached: false });

async function callProvider(provider: FraudCheckProvider, phone: string, s: ReturnType<typeof fraudCheckSettings>): Promise<{ lookup: FraudLookup; transient: boolean }> {
  if (!takeBudget(s.maxCallsPerMinute)) {
    logServerWarning("fraud-check", "Fraud-check call budget for this minute is used up; fallback applied", { provider: provider.key });
    return { lookup: unavailable("rate_limited"), transient: false };
  }
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { ctl.abort(); resolve("timeout"); }, s.timeoutMs); });
  try {
    const answer = await Promise.race([provider.check(phone, ctl.signal), timeout]);
    if (answer === "timeout") { logServerWarning("fraud-check", "Fraud-check lookup timed out", { provider: provider.key }); return { lookup: unavailable("timeout"), transient: true }; }
    if (!isValidFraudHistory(answer)) { logServerWarning("fraud-check", "Fraud-check provider returned an invalid response", { provider: provider.key }); return { lookup: unavailable("invalid_response"), transient: true }; }
    const h: FraudCheckHistory = {
      delivered: answer.delivered,
      cancelled: answer.cancelled,
      ...(answer.returned === undefined ? {} : { returned: answer.returned }),
      ...(answer.total === undefined ? {} : { total: answer.total }),
    };
    const checkedAt = new Date(nowFn()).toISOString();
    if (h.delivered + h.cancelled + (h.returned ?? 0) + (h.total ?? 0) === 0) return { lookup: { status: "no_history", provider: provider.key, checkedAt, cached: false }, transient: false };
    return { lookup: { status: "ok", provider: provider.key, history: h, checkedAt, cached: false }, transient: false };
  } catch (error) {
    // An adapter may say precisely why (auth failed, no counts, ...). Anything else is a plain error. Only the reason code is logged.
    const reason = error instanceof FraudCheckProviderError ? error.reason : "error";
    logServerWarning("fraud-check", "Fraud-check lookup failed; conservative default trust applied", { provider: provider.key, reason });
    return { lookup: unavailable(reason), transient: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Looks up the parcel history for a phone number. Never throws. `fresh: true` (manual admin recheck) skips the cache READ but still shares an
 * in-flight call and refreshes the cache.
 */
export async function lookupFraudCheck(rawPhone: string | null | undefined, opts: { fresh?: boolean } = {}): Promise<FraudLookup> {
  const phone = normalizeBdPhone(rawPhone);
  if (!phone) return unavailable("invalid_phone");
  const s = fraudCheckSettings();
  if (!s.enabled) return unavailable("disabled");
  const provider = activeProvider(s);
  if (!provider) return unavailable("no_provider");

  const key = cacheKey(provider.key, phone);
  if (!opts.fresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > nowFn()) return { ...hit.value, cached: true };
    if (hit) cache.delete(key);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async () => {
    const { lookup, transient } = await callProvider(provider, phone, s);
    // A real answer is cached for the configured time; a transient failure only briefly; budget/config refusals are never cached.
    if (lookup.status !== "unavailable") remember(key, lookup, s.cacheSeconds * 1000);
    else if (transient) remember(key, lookup, Math.min(FAILURE_TTL_MS, s.cacheSeconds * 1000));   // never longer than the cache time; 0 = no memory at all
    return lookup;
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}
