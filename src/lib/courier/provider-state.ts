/**
 * Honest per-courier state for the admin screens. No I/O: everything here is unit-tested directly.
 *
 *   unsupported   this app has NO adapter for the courier (Pathao, RedX today). Nothing is ever called; booking is by hand.
 *   disconnected  the courier cannot be used right now: not configured, switched off, or its newest REAL connection check failed.
 *   configured    credentials are set, but nobody has PROVEN they work: never checked, checked with other credentials, or the
 *                 last check is too old to rely on. This is deliberately NOT "connected".
 *   connected     a real, read-only credential check succeeded recently, with the credentials in use right now.
 *
 * "Connected" can therefore never be produced by configuration alone, by a missing record, or by an old / foreign result.
 */
import { createHash } from "node:crypto";

export type CourierProviderState = "unsupported" | "disconnected" | "configured" | "connected";

export type CourierStateReason =
  | "no_adapter" | "not_configured" | "switched_off" | "check_failed" | "never_checked" | "credentials_changed" | "check_stale" | "verified" | "error";

export const COURIER_STATE_LABEL: Record<CourierProviderState, string> = {
  unsupported: "Unsupported",
  disconnected: "Disconnected",
  configured: "Configured",
  connected: "Connected",
};

/** A connection check older than this no longer counts as evidence (either way): the state falls back to "configured". */
export const CONNECTION_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** A check dated further in the future than this is not trusted (a skewed clock must not keep "connected" on screen). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type StoredConnectionCheck = {
  ok: boolean;
  failureKind: string | null;
  message: string | null;
  fingerprint: string;
  lastSuccessAt: Date | null;
  checkedAt: Date;
};

/**
 * Non-reversible fingerprint of the credentials a check ran with (API key, secret, base URL). It lets a stored result stop applying the
 * moment a credential changes. Computed server-side only and never sent to a browser.
 */
export function credentialFingerprint(cfg: { apiKey: string | null; apiSecret: string | null; baseUrl: string | null }): string {
  return createHash("sha256").update(`courier-connection-v1\n${cfg.apiKey ?? ""}\n${cfg.apiSecret ?? ""}\n${cfg.baseUrl ?? ""}`).digest("hex").slice(0, 16);
}

export type ProviderStateInput = {
  adapterAvailable: boolean;
  /** Why there is no adapter (registry), when there is none. */
  blocker: string | null;
  /** Credentials are present and valid in shape (isCourierUsable). */
  usable: boolean;
  /** Admin-facing configuration problem, when not usable. */
  problem: string | null;
  /** Explicitly switched off (<PREFIX>_ENABLED=false). */
  switchedOff: boolean;
  /** Fingerprint of the credentials in use now (null when none). */
  fingerprint: string | null;
  check: StoredConnectionCheck | null;
  now: Date;
};

export type ProviderStateResult = {
  state: CourierProviderState;
  reason: CourierStateReason;
  /** One admin-facing sentence saying WHY the state is what it is. Never contains a secret. */
  detail: string;
  /** When the newest check that applies to the credentials in use ran (null when none applies). */
  lastCheckedAt: Date | null;
  /** When a check last succeeded with the credentials in use (null when none applies). */
  lastConnectedAt: Date | null;
};

export function deriveProviderState(i: ProviderStateInput): ProviderStateResult {
  const none = { lastCheckedAt: null, lastConnectedAt: null };
  if (!i.adapterAvailable) {
    return { state: "unsupported", reason: "no_adapter", detail: i.blocker ?? "This courier has no API adapter in this app. Record its bookings by hand.", ...none };
  }
  if (!i.usable) {
    return i.switchedOff
      ? { state: "disconnected", reason: "switched_off", detail: i.problem ?? "Switched off.", ...none }
      : { state: "disconnected", reason: "not_configured", detail: i.problem ?? "Not configured.", ...none };
  }
  const c = i.check;
  if (!c) {
    return { state: "configured", reason: "never_checked", detail: "Credentials are set, but no connection check has been made, so it is not confirmed as connected. Run Test connection.", ...none };
  }
  if (i.fingerprint === null || c.fingerprint !== i.fingerprint) {
    return { state: "configured", reason: "credentials_changed", detail: "The credentials changed since the last connection check, so that result no longer applies. Run Test connection.", ...none };
  }
  const age = i.now.getTime() - c.checkedAt.getTime();
  const own = { lastCheckedAt: c.checkedAt, lastConnectedAt: c.lastSuccessAt };
  if (age > CONNECTION_CHECK_TTL_MS || age < -CLOCK_SKEW_MS) {
    return { state: "configured", reason: "check_stale", detail: `The last connection check ${c.ok ? "succeeded" : "failed"} too long ago to rely on. Run Test connection.`, ...own };
  }
  return c.ok
    ? { state: "connected", reason: "verified", detail: "The courier accepted the credentials in the last connection check.", ...own }
    : { state: "disconnected", reason: "check_failed", detail: c.message?.trim() || "The courier did not accept the last connection check.", ...own };
}

/** What an admin can do with a courier from the booking screens. Derived only from the state, so the UI cannot show a different story. */
export type CourierChoiceView = {
  key: string;
  label: string;
  state: CourierProviderState;
  stateLabel: string;
  /** Can be booked through its API from here (credentials present). */
  apiBookable: boolean;
  /** One short line for the picker: the state plus, when relevant, what to do instead. */
  optionText: string;
};

export function courierChoiceView(p: { key: string; label: string; state: CourierProviderState; reason: CourierStateReason; isDefault?: boolean }): CourierChoiceView {
  const stateLabel = COURIER_STATE_LABEL[p.state];
  const apiBookable = p.state === "configured" || p.state === "connected" || (p.state === "disconnected" && p.reason === "check_failed");
  const suffix =
    p.state === "unsupported" ? " (no API adapter: record by hand)"
    : !apiBookable ? " (not configured: record by hand)"
    : p.reason === "check_failed" ? " (last connection check failed)"
    : "";
  return { key: p.key, label: p.label, state: p.state, stateLabel, apiBookable, optionText: `${p.label} — ${stateLabel}${suffix}${p.isDefault ? " · default" : ""}` };
}
