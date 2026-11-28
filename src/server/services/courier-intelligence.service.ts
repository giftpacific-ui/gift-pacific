import "server-only";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { logServerWarning } from "@/lib/logger";
import { consumeRateLimit } from "@/lib/rate-limit";
import { normalizeBdPhone } from "@/lib/advance-policy";
import { getCourierProviderConfig, isCourierUsable } from "@/lib/courier/config";
import { combineReports, orderReports, type CombinedReport } from "@/lib/courier-intelligence/combine";
import { PROVIDER_DESCRIPTORS, providerDescriptor } from "@/lib/courier-intelligence/registry";
import { verifyHistoryMetrics } from "@/lib/courier-intelligence/verify";
import { EMPTY_METRICS, INTEL_PROVIDERS, type FailureReason, type HistoryAdapter, type IntelProviderKey, type ProviderDescriptor, type ProviderReport } from "@/lib/courier-intelligence/types";
import { HISTORY_ADAPTER_FACTORIES } from "@/server/services/courier-intelligence-providers";

/**
 * Courier intelligence: ONE place that asks the couriers how a phone number's parcels ended, stores each answer, and hands every consumer
 * (checkout advance decision, order page, fraud review, admin Fraud Check page) the same normalised, validated report.
 *
 * SUPPORTED COURIERS: only those whose documentation offers a customer-history lookup (lib/courier-intelligence/registry.ts). Today that is
 * Steadfast. Pathao and REDX are reported as `unsupported` (their official APIs publish no such contract, re-checked 2026-11-23) and are NEVER
 * called: nothing is simulated. Couriers are independent: each is looked up in parallel with its own adapter, timeout, call budget, cache rows
 * and failure, and one courier's failure is a typed `unavailable` report for THAT courier only: it is never read as zero parcels, never as fraud,
 * and never removes another courier's answer.
 *
 * VERIFIED REPORTS ONLY: every adapter answer passes the verification gate (lib/courier-intelligence/verify.ts) before it is stored or combined:
 * a metric the courier's descriptor does not list is dropped, implausible or contradictory numbers make the whole answer `invalid_response`.
 *
 * Reliability rules (fail-safe, never fail-open):
 *  - Never throws. Every failure becomes a typed report (unavailable / not_configured / unsupported); one courier failing never discards another's answer.
 *  - Answers are STORED (CourierIntelligenceSnapshot, append-only), and the stored rows are also the cache shared by every server instance:
 *    a new lookup is skipped while the newest answer is younger than the cache time (FRAUD_CHECK_CACHE_SECONDS, default 10 minutes, max 24 h) and,
 *    for the checkout decision, younger than the policy's maximum evidence age. A manual recheck (`fresh`) always asks again and ADDS a row.
 *  - Failures are remembered for at most 30 s (never longer than the cache time), so a struggling courier is not hammered.
 *  - Simultaneous lookups of one phone on one instance share ONE courier call; across instances the shared cache plus the per-courier budget bound the load.
 *  - A per-courier call budget per minute is kept in the database (FRAUD_CHECK_MAX_CALLS_PER_MINUTE, default 60): excess lookups become `rate_limited`.
 *  - No raw phone number is stored or logged: a keyed hash identifies the number, a masked form is shown, and no raw provider payload is kept.
 */

export type IntelligenceSource = "CHECKOUT" | "ADMIN" | "ORDER_RECHECK";
type Env = Record<string, string | undefined>;

// ---- configuration ---------------------------------------------------------------------------------------------------------------------------
function intEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function intelligenceSettings(env: Env = process.env) {
  return {
    enabled: (env.FRAUD_CHECK_ENABLED ?? "true").trim().toLowerCase() !== "false" && (env.FRAUD_CHECK_PROVIDER ?? "").trim().toLowerCase() !== "none",
    timeoutMs: intEnv(env, "FRAUD_CHECK_TIMEOUT_MS", 3000, 500, 10_000),
    cacheSeconds: intEnv(env, "FRAUD_CHECK_CACHE_SECONDS", 600, 0, 86_400),
    maxCallsPerMinute: intEnv(env, "FRAUD_CHECK_MAX_CALLS_PER_MINUTE", 60, 1, 1000),
    retentionDays: intEnv(env, "COURIER_INTEL_RETENTION_DAYS", 90, 7, 730),
  };
}

// ---- test seams (ignored in production) --------------------------------------------------------------------------------------------------------
let testAdapters: Partial<Record<IntelProviderKey, HistoryAdapter | null>> | undefined;
let testDescriptors: Partial<Record<IntelProviderKey, ProviderDescriptor>> | undefined;
let nowFn: () => number = () => Date.now();
let phoneVerifiedForTests: boolean | undefined;

/** Test seam only: replace adapters (null = not configured). Ignored in production. */
export function setIntelligenceAdaptersForTests(a: typeof testAdapters) { if (process.env.NODE_ENV !== "production") testAdapters = a; }
/**
 * Test seam only: replaces courier descriptors, so a test can model a courier that DOES publish a history contract (with a mocked adapter) and
 * prove the combination rules for every courier mix. Ignored in production, where capability is a fact in lib/courier-intelligence/registry.ts.
 */
export function setIntelligenceDescriptorsForTests(d: typeof testDescriptors) { if (process.env.NODE_ENV !== "production") testDescriptors = d; }
/**
 * True when asking this courier would really contact it: it has a documented lookup AND an adapter that is configured. Used by the admin entry
 * points so that a courier that cannot be asked (unsupported, not configured) is never charged against an admin's lookup budget.
 */
export function courierAskable(provider: IntelProviderKey): boolean {
  return descriptorFor(provider).capability === "supported" && adapterFor(provider) !== null;
}

/** Test seam only: a controllable clock. Ignored in production. */
export function setIntelligenceClockForTests(fn: (() => number) | undefined) { if (process.env.NODE_ENV !== "production") nowFn = fn ?? (() => Date.now()); }
/** Test seam only: forgets in-flight lookups and descriptor overrides. Ignored in production. */
export function resetIntelligenceStateForTests() { if (process.env.NODE_ENV !== "production") { inflight.clear(); testDescriptors = undefined; } }
/** Test seam only: simulates a FUTURE verified-phone mechanism. Ignored in production. */
export function setPhoneVerifiedForTests(v: boolean | undefined) { if (process.env.NODE_ENV !== "production") phoneVerifiedForTests = v; }

/**
 * There is NO verified-phone mechanism in this project (no OTP; the account phone is a free-text profile field). Until one is built and tested,
 * a good courier history is credited only if the admin policy explicitly accepts unverified phones. Do not make this return true for a profile phone.
 */
export function isPhoneVerified(): boolean {
  if (phoneVerifiedForTests !== undefined && process.env.NODE_ENV !== "production") return phoneVerifiedForTests;
  return false;
}

/** The descriptor in force: the documented one, except under the test seam above. */
export function descriptorFor(provider: IntelProviderKey): ProviderDescriptor {
  if (testDescriptors && process.env.NODE_ENV !== "production" && testDescriptors[provider]) return testDescriptors[provider]!;
  return providerDescriptor(provider);
}

function adapterFor(provider: IntelProviderKey): HistoryAdapter | null {
  let adapter: HistoryAdapter | null;
  if (testAdapters && process.env.NODE_ENV !== "production" && provider in testAdapters) adapter = testAdapters[provider] ?? null;
  else if (descriptorFor(provider).capability !== "supported") return null;
  else adapter = HISTORY_ADAPTER_FACTORIES[provider]?.() ?? null;
  // An adapter must speak for the courier it is registered under: a mismatch is a wiring mistake, and its answers would be filed under the wrong courier.
  if (adapter && adapter.key !== provider) {
    logServerWarning("courier-intelligence", "adapter key does not match its courier; not used", { provider });
    return null;
  }
  return adapter;
}

// ---- identity helpers (no raw phone is ever stored or logged) -----------------------------------------------------------------------------------
export function hashPhone(phone: string): string {
  return createHmac("sha256", process.env.AUTH_SECRET || "courier-intelligence").update(`courier-intel|${phone}`).digest("hex");
}
export function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}*****${phone.slice(-3)}` : "***";
}

// ---- stored row <-> report ---------------------------------------------------------------------------------------------------------------------
type Row = {
  provider: string; status: string; reason: string | null;
  delivered: number | null; cancelled: number | null; returned: number | null; failed: number | null; total: number | null;
  reportedDeliveryRate: unknown; reportedCancellationRate: unknown; fraudReports: number | null; checkedAt: Date;
};
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
function reportFromRow(r: Row, cached: boolean): ProviderReport {
  return {
    provider: r.provider as IntelProviderKey,
    status: r.status as ProviderReport["status"],
    reason: (r.reason as FailureReason | null) ?? null,
    checkedAt: r.checkedAt.toISOString(),
    cached,
    delivered: r.delivered ?? null, cancelled: r.cancelled ?? null, returned: r.returned ?? null, failed: r.failed ?? null, total: r.total ?? null,
    reportedDeliveryRate: num(r.reportedDeliveryRate), reportedCancellationRate: num(r.reportedCancellationRate), fraudReports: r.fraudReports ?? null,
  };
}
const bare = (provider: IntelProviderKey, status: ProviderReport["status"], reason: FailureReason | null = null): ProviderReport => ({
  provider, status, reason, checkedAt: new Date(nowFn()).toISOString(), cached: false, ...EMPTY_METRICS,
});

// ---- one provider -------------------------------------------------------------------------------------------------------------------------------
const FAILURE_TTL_MS = 30_000;
const inflight = new Map<string, Promise<ProviderReport>>();

type LookupOpts = { fresh?: boolean; maxAgeSeconds?: number; source: IntelligenceSource };

async function lookupProvider(provider: IntelProviderKey, phone: string, opts: LookupOpts): Promise<ProviderReport> {
  const s = intelligenceSettings();
  if (descriptorFor(provider).capability !== "supported") return bare(provider, "unsupported");
  if (!s.enabled) return bare(provider, "unavailable", "disabled");
  const adapter = adapterFor(provider);
  if (!adapter) return bare(provider, "not_configured");

  const hash = hashPhone(phone);
  const now = nowFn();
  if (!opts.fresh) {
    // Serve the newest stored answer while it has not expired AND (for the checkout decision) is not older than the policy's maximum evidence age.
    const newest = await prisma.courierIntelligenceSnapshot.findFirst({ where: { phoneHash: hash, provider }, orderBy: { checkedAt: "desc" } });
    if (newest && newest.expiresAt.getTime() > now && (opts.maxAgeSeconds === undefined || now - newest.checkedAt.getTime() <= opts.maxAgeSeconds * 1000)) {
      return reportFromRow(newest, true);
    }
  }
  const key = `${provider}|${hash}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = callAndStore(provider, adapter, phone, hash, s, opts).finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}

async function callAndStore(provider: IntelProviderKey, adapter: HistoryAdapter, phone: string, hash: string, s: ReturnType<typeof intelligenceSettings>, opts: LookupOpts): Promise<ProviderReport> {
  const masked = maskPhone(phone);
  // Per-courier call budget, shared by every instance (database-backed). Refusals are not stored (they say nothing about the courier).
  const budget = await consumeRateLimit({ name: `courier-intel-${provider}`, limit: s.maxCallsPerMinute, windowSeconds: 60 }, ["global"], nowFn());
  if (!budget.ok) {
    logServerWarning("courier-intelligence", "lookup budget used up; no courier call made", { provider });
    return bare(provider, "unavailable", "rate_limited");
  }
  let answer: Awaited<ReturnType<HistoryAdapter["lookup"]>>;
  try {
    // The transport enforces the timeout; the race below is a second guard so a misbehaving adapter can never hold a checkout open.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), s.timeoutMs + 500); });
    const r = await Promise.race([adapter.lookup(phone, s.timeoutMs), guard]);
    if (timer) clearTimeout(timer);
    answer = r === "timeout" ? { ok: false, reason: "timeout" } : r;
  } catch {
    answer = { ok: false, reason: "error" };
  }

  const checkedAt = new Date(nowFn());
  const cacheMs = s.cacheSeconds * 1000;
  if (!answer.ok) {
    logServerWarning("courier-intelligence", "lookup failed", { provider, reason: answer.reason, phone: masked });
    const report = { ...bare(provider, "unavailable", answer.reason), checkedAt: checkedAt.toISOString() };
    await store(provider, hash, masked, report, checkedAt, new Date(checkedAt.getTime() + Math.min(FAILURE_TTL_MS, cacheMs)), opts.source);
    return report;
  }
  // The verification gate: only a plausible, non-contradictory answer limited to the metrics this courier is documented to report may become a report.
  const verified = verifyHistoryMetrics(descriptorFor(provider), answer.metrics);
  if (!verified.ok) {
    logServerWarning("courier-intelligence", "answer failed verification; not used", { provider, phone: masked });
    const report = { ...bare(provider, "unavailable", "invalid_response"), checkedAt: checkedAt.toISOString() };
    await store(provider, hash, masked, report, checkedAt, new Date(checkedAt.getTime() + Math.min(FAILURE_TTL_MS, cacheMs)), opts.source);
    return report;
  }
  if (verified.stripped.length > 0) {
    logServerWarning("courier-intelligence", "answer carried metrics this courier is not documented to report; they were ignored", { provider, metrics: verified.stripped.join(",") });
  }
  const m = verified.metrics;
  const report: ProviderReport = {
    provider, status: m.empty ? "no_history" : "ok", reason: null, checkedAt: checkedAt.toISOString(), cached: false,
    delivered: m.delivered, cancelled: m.cancelled, returned: m.returned, failed: m.failed, total: m.total,
    reportedDeliveryRate: m.reportedDeliveryRate, reportedCancellationRate: m.reportedCancellationRate, fraudReports: m.fraudReports,
  };
  await store(provider, hash, masked, report, checkedAt, new Date(checkedAt.getTime() + cacheMs), opts.source);
  return report;
}

async function store(provider: IntelProviderKey, hash: string, masked: string, r: ProviderReport, checkedAt: Date, expiresAt: Date, source: IntelligenceSource) {
  try {
    await prisma.courierIntelligenceSnapshot.create({
      data: {
        phoneHash: hash, phoneMasked: masked, provider, status: r.status, reason: r.reason,
        delivered: r.delivered, cancelled: r.cancelled, returned: r.returned, failed: r.failed, total: r.total,
        reportedDeliveryRate: r.reportedDeliveryRate, reportedCancellationRate: r.reportedCancellationRate, fraudReports: r.fraudReports,
        source, checkedAt, expiresAt,
      },
    });
  } catch (error) {
    // Storing is best effort: the answer is still returned. A concurrent identical insert (same millisecond) is simply a duplicate.
    if ((error as { code?: string })?.code !== "P2002") logServerWarning("courier-intelligence", "could not store the lookup", { provider });
  }
}

// ---- public API -----------------------------------------------------------------------------------------------------------------------------------
export type IntelligenceResult = {
  /** The service clock when this result was produced (ISO). Evidence age is measured against it. */
  asOf: string;
  phoneValid: boolean;
  /** e.g. 017*****678. Null when the phone is invalid. The full number is never returned. */
  phoneMasked: string | null;
  reports: ProviderReport[];
  combined: CombinedReport;
};

const invalidResult = (): IntelligenceResult => ({
  asOf: new Date(nowFn()).toISOString(), phoneValid: false, phoneMasked: null,
  reports: INTEL_PROVIDERS.map((p) => bare(p, "unavailable", "invalid_phone")),
  combined: combineReports(INTEL_PROVIDERS.map((p) => bare(p, "unavailable", "invalid_phone"))),
});

/** One courier's report for a phone. Never throws. */
export async function getProviderReport(rawPhone: string | null | undefined, provider: IntelProviderKey, opts: LookupOpts): Promise<{ phoneValid: boolean; phoneMasked: string | null; report: ProviderReport }> {
  const phone = normalizeBdPhone(rawPhone);
  if (!phone) return { phoneValid: false, phoneMasked: null, report: bare(provider, "unavailable", "invalid_phone") };
  try {
    return { phoneValid: true, phoneMasked: maskPhone(phone), report: await lookupProvider(provider, phone, opts) };
  } catch {
    return { phoneValid: true, phoneMasked: maskPhone(phone), report: bare(provider, "unavailable", "error") };
  }
}

/** Every courier's report plus the combined report. Couriers are asked in parallel; one failing never affects another. Never throws. */
export async function getCourierIntelligence(rawPhone: string | null | undefined, opts: LookupOpts): Promise<IntelligenceResult> {
  const phone = normalizeBdPhone(rawPhone);
  if (!phone) return invalidResult();
  const reports = orderReports(await Promise.all(INTEL_PROVIDERS.map(async (p) => (await getProviderReport(phone, p, opts)).report)));
  return { asOf: new Date(nowFn()).toISOString(), phoneValid: true, phoneMasked: maskPhone(phone), reports, combined: combineReports(reports) };
}

/**
 * What is ALREADY stored for a phone (newest answer per courier, whatever its age): no courier is called. Used where opening a page must never
 * trigger an API call (the order page). Each report says when it was checked, so its freshness is visible. A configured courier with no stored
 * answer is listed in `unchecked` (not checked yet): it is neither a failure nor "zero parcels", and stays out of the combined report.
 */
export async function getStoredIntelligence(rawPhone: string | null | undefined): Promise<IntelligenceResult & { unchecked: IntelProviderKey[] }> {
  const phone = normalizeBdPhone(rawPhone);
  if (!phone) return { ...invalidResult(), unchecked: [] };
  const hash = hashPhone(phone);
  const reports: ProviderReport[] = [];
  const unchecked: IntelProviderKey[] = [];
  for (const p of INTEL_PROVIDERS) {
    if (descriptorFor(p).capability !== "supported") { reports.push(bare(p, "unsupported")); continue; }
    if (!adapterFor(p)) { reports.push(bare(p, "not_configured")); continue; }
    const row = await prisma.courierIntelligenceSnapshot.findFirst({ where: { phoneHash: hash, provider: p }, orderBy: { checkedAt: "desc" } });
    if (row) reports.push(reportFromRow(row, true));
    else unchecked.push(p);
  }
  return { asOf: new Date(nowFn()).toISOString(), phoneValid: true, phoneMasked: maskPhone(phone), reports: orderReports(reports), combined: combineReports(reports), unchecked };
}

/** Older-than-retention snapshots are deleted (a scheduled job calls this). The rows hold no raw phone number or payload. */
export async function purgeIntelligenceSnapshots(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - intelligenceSettings().retentionDays * 86_400_000);
  const r = await prisma.courierIntelligenceSnapshot.deleteMany({ where: { checkedAt: { lt: cutoff } } });
  return r.count;
}

// ---- diagnostics -------------------------------------------------------------------------------------------------------------------------------
export type ProviderState = "unsupported" | "not_configured" | "configured_unverified" | "connected" | "error";

export type ProviderStatusView = {
  key: IntelProviderKey;
  label: string;
  state: ProviderState;
  /** Booking credentials exist for this courier (a different capability from the history lookup). */
  bookingConfigured: boolean;
  summary: string;
  semantics: string;
  endpoint: string | null;
  verification: (typeof PROVIDER_DESCRIPTORS)[IntelProviderKey]["verification"];
  supportedMetrics: readonly string[];
  unsupportedMetrics: readonly string[];
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: FailureReason | null;
  problem: string | null;
};

/**
 * Per-courier state of the HISTORY lookup (separate from booking and from status sync). "connected" means a real lookup succeeded and is on
 * record; credentials alone only ever give "configured, not yet verified". Never includes a secret.
 */
export async function getIntelligenceProviderStatuses(env: Env = process.env): Promise<ProviderStatusView[]> {
  const s = intelligenceSettings(env);
  const out: ProviderStatusView[] = [];
  for (const key of INTEL_PROVIDERS) {
    const d = descriptorFor(key);
    const courier = key === "steadfast" ? getCourierProviderConfig("steadfast", env) : null;
    const bookingConfigured = courier ? isCourierUsable(courier) : false;
    const base = {
      key, label: d.label, bookingConfigured, summary: d.summary, semantics: d.semantics, endpoint: d.endpoint, verification: d.verification,
      supportedMetrics: d.supportedMetrics, unsupportedMetrics: d.unsupportedMetrics, lastSuccessAt: null as string | null, lastFailureAt: null as string | null,
      lastFailureReason: null as FailureReason | null, problem: null as string | null,
    };
    if (d.capability !== "supported") { out.push({ ...base, state: "unsupported" }); continue; }
    if (!s.enabled) { out.push({ ...base, state: "not_configured", problem: "The courier history check is switched off (FRAUD_CHECK_ENABLED=false or FRAUD_CHECK_PROVIDER=none)." }); continue; }
    if (!bookingConfigured || !adapterFor(key)) { out.push({ ...base, state: "not_configured", problem: courier?.problem ?? "Credentials are not set." }); continue; }
    const ok = await prisma.courierIntelligenceSnapshot.findFirst({ where: { provider: key, status: { in: ["ok", "no_history"] } }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true } });
    const bad = await prisma.courierIntelligenceSnapshot.findFirst({ where: { provider: key, status: "unavailable" }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true, reason: true } });
    const lastOk = ok?.checkedAt.getTime() ?? 0;
    const lastBad = bad?.checkedAt.getTime() ?? 0;
    const state: ProviderState = lastBad > lastOk ? "error" : lastOk > 0 ? "connected" : "configured_unverified";
    out.push({ ...base, state, lastSuccessAt: ok ? ok.checkedAt.toISOString() : null, lastFailureAt: bad ? bad.checkedAt.toISOString() : null, lastFailureReason: (bad?.reason as FailureReason | null) ?? null });
  }
  return out;
}
