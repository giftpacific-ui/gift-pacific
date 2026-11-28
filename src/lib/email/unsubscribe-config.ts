/**
 * Configuration for unsubscribe links (Prompt 11): the dedicated secret and the public base URL. PURE and `node:crypto`-free on purpose, so that
 * src/lib/production-checks.ts (imported by instrumentation.ts at server start) can validate them without pulling crypto into that import chain.
 * The token maths that USES the secret lives in ./unsubscribe.
 */
import { isLoopbackHost } from "@/lib/email/list-unsubscribe";

export const UNSUBSCRIBE_SECRET_ENV = "EMAIL_UNSUBSCRIBE_SECRET";
export const UNSUBSCRIBE_SECRET_MIN_LENGTH = 32;
const KNOWN_PLACEHOLDERS = new Set(["replace-with-a-long-random-string", "changeme", "secret", "password", "your-secret-here"]);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Env = Record<string, string | undefined>;

// ------------------------------------------------------------------------------------------------------------------------------------ secret

export type UnsubscribeSecretFailure = "secret_missing" | "secret_weak" | "secret_reused";
export type UnsubscribeSecret = { ok: true; secret: string } | { ok: false; reason: UnsubscribeSecretFailure };

/**
 * The dedicated secret, or the reason it cannot be used. Never falls back to anything else: there is no default, and the value must not be (a copy of)
 * AUTH_SECRET, CRON_SECRET, the SMTP password or any NEXT_PUBLIC_* value (a public value is not a secret). The reason is a fixed code: it never
 * contains the value.
 */
export function readUnsubscribeSecret(env: Env = process.env): UnsubscribeSecret {
  const raw = env[UNSUBSCRIBE_SECRET_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "secret_missing" };
  const secret = raw.trim();
  if (secret.length < UNSUBSCRIBE_SECRET_MIN_LENGTH || CONTROL.test(secret) || KNOWN_PLACEHOLDERS.has(secret.toLowerCase()) || /^(.)\1+$/.test(secret)) {
    return { ok: false, reason: "secret_weak" };
  }
  const others = [env.AUTH_SECRET, env.CRON_SECRET, env.SMTP_PASS, env.SMTP_PASS?.replace(/\s+/g, ""), ...Object.entries(env).filter(([k]) => k.startsWith("NEXT_PUBLIC_")).map(([, v]) => v)];
  if (others.some((other) => typeof other === "string" && other.trim() !== "" && other.trim() === secret)) return { ok: false, reason: "secret_reused" };
  return { ok: true, secret };
}

// ---------------------------------------------------------------------------------------------------------------------------------- base URL

export type UnsubscribeBaseUrl = { ok: true; origin: string } | { ok: false; reason: "base_url_invalid" };

/**
 * The public origin links are built on: NEXT_PUBLIC_APP_URL, validated. Must be an origin only (no credentials, path, query or fragment). In
 * production it must be https and not a loopback host; elsewhere http is accepted for a loopback host only. A missing value is accepted outside
 * production only, as the same localhost default the rest of the app uses.
 */
export function readUnsubscribeBaseUrl(env: Env = process.env): UnsubscribeBaseUrl {
  const production = env.NODE_ENV === "production";
  const raw = (env.NEXT_PUBLIC_APP_URL ?? "").trim() || (production ? "" : "http://localhost:3000");
  if (!raw || CONTROL.test(raw) || /\s/.test(raw)) return { ok: false, reason: "base_url_invalid" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "base_url_invalid" };
  }
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/" || !u.hostname) return { ok: false, reason: "base_url_invalid" };
  const loopback = isLoopbackHost(u.hostname);
  const acceptable = u.protocol === "https:" ? !(production && loopback) : u.protocol === "http:" && !production && loopback;
  return acceptable ? { ok: true, origin: u.origin } : { ok: false, reason: "base_url_invalid" };
}

export type UnsubscribeConfig = { ok: true; secret: string; origin: string; nodeEnv: string | undefined } | { ok: false; reason: UnsubscribeSecretFailure | "base_url_invalid" };

/** Everything needed to create links, or the first thing that is wrong. Nothing is created when this fails. */
export function readUnsubscribeConfig(env: Env = process.env): UnsubscribeConfig {
  const secret = readUnsubscribeSecret(env);
  if (!secret.ok) return secret;
  const base = readUnsubscribeBaseUrl(env);
  if (!base.ok) return base;
  return { ok: true, secret: secret.secret, origin: base.origin, nodeEnv: env.NODE_ENV };
}
