/**
 * Honest provider state: "connected" can only come from a real, recent, matching, successful check. Pure derivation, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTION_CHECK_TTL_MS, COURIER_STATE_LABEL, courierChoiceView, credentialFingerprint, deriveProviderState,
  type ProviderStateInput, type StoredConnectionCheck,
} from "@/lib/courier/provider-state";
import { courierPickerOptions, initialPickerValue } from "@/lib/courier/provider-picker";
import { COURIER_PROVIDERS, getCourierProviderStatuses } from "@/lib/courier/registry";
import { describeDefaultCourier, isCourierSwitchedOff } from "@/lib/courier/config";

const NOW = new Date("2026-11-22T12:00:00Z");
const creds = { apiKey: "KEY-1", apiSecret: "SEC-1", baseUrl: null };
const FP = credentialFingerprint(creds);
const check = (o: Partial<StoredConnectionCheck> = {}): StoredConnectionCheck => ({ ok: true, failureKind: null, message: null, fingerprint: FP, lastSuccessAt: NOW, checkedAt: new Date(NOW.getTime() - 60_000), ...o });
const input = (o: Partial<ProviderStateInput> = {}): ProviderStateInput => ({
  adapterAvailable: true, blocker: null, usable: true, problem: null, switchedOff: false, fingerprint: FP, check: null, now: NOW, ...o,
});

test("no adapter (Pathao, RedX) is UNSUPPORTED whatever else is passed in, and never connected", () => {
  const r = deriveProviderState(input({ adapterAvailable: false, blocker: "no adapter", usable: true, check: check() }));
  assert.equal(r.state, "unsupported");
  assert.equal(r.reason, "no_adapter");
  assert.equal(r.detail, "no adapter");
  assert.equal(r.lastCheckedAt, null);
});

test("credentials alone are CONFIGURED, not connected (never checked)", () => {
  const r = deriveProviderState(input());
  assert.equal(r.state, "configured");
  assert.equal(r.reason, "never_checked");
  assert.match(r.detail, /not confirmed as connected/);
});

test("a successful, recent check with the SAME credentials is CONNECTED", () => {
  const r = deriveProviderState(input({ check: check() }));
  assert.equal(r.state, "connected");
  assert.equal(r.reason, "verified");
  assert.ok(r.lastCheckedAt && r.lastConnectedAt);
});

test("a failed recent check is DISCONNECTED and carries the stored reason", () => {
  const r = deriveProviderState(input({ check: check({ ok: false, message: "Steadfast refused the API key / secret.", lastSuccessAt: null }) }));
  assert.equal(r.state, "disconnected");
  assert.equal(r.reason, "check_failed");
  assert.match(r.detail, /refused/);
});

test("REGRESSION: rotating a credential makes an old 'connected' stop applying", () => {
  const other = credentialFingerprint({ ...creds, apiSecret: "SEC-2" });
  assert.notEqual(other, FP);
  const r = deriveProviderState(input({ fingerprint: other, check: check() }));
  assert.equal(r.state, "configured");
  assert.equal(r.reason, "credentials_changed");
  assert.equal(r.lastConnectedAt, null);
  const none = deriveProviderState(input({ fingerprint: null, check: check() }));
  assert.equal(none.state, "configured");
});

test("REGRESSION: an old check is not evidence either way (state falls back to configured)", () => {
  for (const ok of [true, false]) {
    const r = deriveProviderState(input({ check: check({ ok, checkedAt: new Date(NOW.getTime() - CONNECTION_CHECK_TTL_MS - 1) }) }));
    assert.equal(r.state, "configured", `ok=${ok}`);
    assert.equal(r.reason, "check_stale");
  }
  const edge = deriveProviderState(input({ check: check({ checkedAt: new Date(NOW.getTime() - CONNECTION_CHECK_TTL_MS) }) }));
  assert.equal(edge.state, "connected"); // exactly at the limit is still fresh
});

test("REGRESSION: a check dated in the future (clock skew) cannot keep 'connected' on screen", () => {
  assert.equal(deriveProviderState(input({ check: check({ checkedAt: new Date(NOW.getTime() + 60 * 60_000) }) })).state, "configured");
  assert.equal(deriveProviderState(input({ check: check({ checkedAt: new Date(NOW.getTime() + 60_000) }) })).state, "connected"); // small skew tolerated
});

test("not configured / switched off are DISCONNECTED with the real reason; a stored success cannot override that", () => {
  const off = deriveProviderState(input({ usable: false, switchedOff: true, problem: "Switched off (STEADFAST_ENABLED=false).", check: check() }));
  assert.deepEqual([off.state, off.reason], ["disconnected", "switched_off"]);
  const none = deriveProviderState(input({ usable: false, problem: "Not configured.", check: check() }));
  assert.deepEqual([none.state, none.reason], ["disconnected", "not_configured"]);
  assert.equal(none.lastConnectedAt, null);
});

test("the fingerprint is stable, depends on key / secret / base URL, and reveals none of them", () => {
  assert.equal(credentialFingerprint(creds), credentialFingerprint({ ...creds }));
  assert.notEqual(credentialFingerprint(creds), credentialFingerprint({ ...creds, baseUrl: "https://x.example" }));
  assert.notEqual(credentialFingerprint(creds), credentialFingerprint({ ...creds, apiKey: "KEY-2" }));
  assert.ok(!FP.includes("KEY") && !FP.includes("SEC"));
  assert.equal(FP.length, 16);
});

test("choice views: only configured / connected / check-failed couriers are API-bookable; unsupported and unconfigured are by hand", () => {
  const v = (state: Parameters<typeof courierChoiceView>[0]["state"], reason: Parameters<typeof courierChoiceView>[0]["reason"], isDefault = false) =>
    courierChoiceView({ key: "k", label: "K", state, reason, isDefault });
  assert.equal(v("connected", "verified").apiBookable, true);
  assert.equal(v("configured", "never_checked").apiBookable, true);
  assert.equal(v("disconnected", "check_failed").apiBookable, true); // a stale/failed probe must not lock out booking; the booking itself is the real test
  assert.equal(v("disconnected", "not_configured").apiBookable, false);
  assert.equal(v("disconnected", "switched_off").apiBookable, false);
  assert.equal(v("disconnected", "error").apiBookable, false);
  const un = v("unsupported", "no_adapter");
  assert.equal(un.apiBookable, false);
  assert.match(un.optionText, /Unsupported.*no API adapter: record by hand/);
  assert.match(v("connected", "verified", true).optionText, /Connected · default/);
  assert.match(v("disconnected", "check_failed").optionText, /last connection check failed/);
  assert.equal(COURIER_STATE_LABEL.configured, "Configured");
});

test("registry: Steadfast has an adapter; Pathao and RedX are listed as unsupported and NEVER usable, whatever the environment says", () => {
  assert.deepEqual(COURIER_PROVIDERS.map((p) => p.key), ["steadfast", "pathao", "redx"]);
  const env = { PATHAO_API_KEY: "k", PATHAO_API_SECRET: "s", REDX_API_KEY: "k", REDX_ACCESS_TOKEN: "t", COURIER_PROVIDER: "pathao", STEADFAST_API_KEY: "a", STEADFAST_API_SECRET: "b" };
  const statuses = getCourierProviderStatuses(env);
  for (const key of ["pathao", "redx"]) {
    const s = statuses.find((p) => p.key === key)!;
    assert.equal(s.adapterAvailable, false);
    assert.equal(s.usable, false);
    assert.equal(s.capabilities.cancel, false);
    assert.match(s.problem ?? "", /no adapter/i);
  }
  assert.equal(statuses.find((p) => p.key === "steadfast")!.usable, true);
});

test("picker: Automatic comes first, names the real default, and is the starting choice; unsupported couriers are listed but disabled", () => {
  const choices = [
    courierChoiceView({ key: "steadfast", label: "Steadfast", state: "connected", reason: "verified", isDefault: true }),
    courierChoiceView({ key: "pathao", label: "Pathao", state: "unsupported", reason: "no_adapter" }),
    courierChoiceView({ key: "redx", label: "RedX", state: "unsupported", reason: "no_adapter" }),
  ];
  const opts = courierPickerOptions(choices, { key: "steadfast", message: "x" });
  assert.deepEqual(opts.map((o) => o.value), ["", "steadfast", "pathao", "redx"]);
  assert.match(opts[0].label, /Automatic — Steadfast \(default\)/);
  assert.equal(opts[0].disabled, false);
  assert.deepEqual(opts.map((o) => o.disabled), [false, false, true, true]);
  assert.equal(initialPickerValue(opts), "", "starts on Automatic, so the configured default is never silently overridden");
});

test("REGRESSION: with two bookable couriers the picker still starts on Automatic, not on the first courier in the list", () => {
  const choices = [
    courierChoiceView({ key: "a", label: "A", state: "configured", reason: "never_checked" }),
    courierChoiceView({ key: "b", label: "B", state: "connected", reason: "verified", isDefault: true }),
  ];
  const opts = courierPickerOptions(choices, { key: "b", message: "b is the default" });
  assert.equal(initialPickerValue(opts), "");
  assert.match(opts[0].label, /B \(default\)/);
});

test("picker with no default and nothing bookable: Automatic is disabled and nothing is selectable", () => {
  const choices = [
    courierChoiceView({ key: "steadfast", label: "Steadfast", state: "disconnected", reason: "not_configured" }),
    courierChoiceView({ key: "pathao", label: "Pathao", state: "unsupported", reason: "no_adapter" }),
  ];
  const opts = courierPickerOptions(choices, { key: null, message: "none" });
  assert.equal(opts[0].disabled, true);
  assert.match(opts[0].label, /no default courier available/);
  assert.ok(opts.every((o) => o.disabled));
  assert.equal(initialPickerValue(opts), "");
});

test("default selection rules: explicit, only-configured, first-configured, unavailable and unsupported never fall through to another courier", () => {
  const live = { STEADFAST_API_KEY: "a", STEADFAST_API_SECRET: "b" };
  assert.deepEqual([describeDefaultCourier({}).key, describeDefaultCourier({}).reason], [null, "none_configured"]);
  assert.deepEqual([describeDefaultCourier(live).key, describeDefaultCourier(live).reason], ["steadfast", "only_configured"]);
  assert.deepEqual([describeDefaultCourier({ ...live, COURIER_DEFAULT_PROVIDER: "steadfast" }).reason], ["explicit"]);
  // The owner named a courier that is switched off: parcels must NOT be silently routed elsewhere.
  const off = describeDefaultCourier({ ...live, COURIER_DEFAULT_PROVIDER: "steadfast", STEADFAST_ENABLED: "false" });
  assert.deepEqual([off.key, off.reason], [null, "explicit_unavailable"]);
  // Naming Pathao (no adapter) must not fall back to Steadfast either.
  const pathao = describeDefaultCourier({ ...live, COURIER_DEFAULT_PROVIDER: "pathao" });
  assert.deepEqual([pathao.key, pathao.reason], [null, "explicit_unsupported"]);
  assert.match(pathao.message, /no API adapter/);
  assert.equal(isCourierSwitchedOff("steadfast", { STEADFAST_ENABLED: "FALSE" }), true);
  assert.equal(isCourierSwitchedOff("steadfast", {}), false);
});
