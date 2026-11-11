import { enabledProviders, partiallyConfiguredProviders } from "@/lib/oauth/config";
import { getCourierProviderConfig } from "@/lib/courier/config";
import { KNOWN_FRAUD_PROVIDERS } from "@/lib/fraud-check";
/**
 * Misconfigurations that are SAFE to start with in development but wrong in
 * production. Pure (unit-tested); surfaced at server start by
 * `instrumentation.ts` as loud log lines. Never prints secret values.
 */
type Env = Record<string, string | undefined>;

export type ConfigProblem = { severity: "critical" | "warning"; message: string };

const KNOWN_PLACEHOLDER_SECRETS = new Set(["replace-with-a-long-random-string", "changeme", "secret", "password", "your-secret-here"]);

export function findProductionConfigProblems(env: Env): ConfigProblem[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: ConfigProblem[] = [];

  const secret = env.AUTH_SECRET?.trim() ?? "";
  if (!secret || KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    problems.push({ severity: "critical", message: "AUTH_SECRET is missing or is a well-known placeholder — anyone could forge login sessions. Generate one with `openssl rand -base64 48`." });
  } else if (secret.length < 32) {
    problems.push({ severity: "critical", message: "AUTH_SECRET is shorter than 32 characters. Use `openssl rand -base64 48`." });
  }

  const url = env.NEXT_PUBLIC_APP_URL?.trim() ?? "";
  try {
    const u = new URL(url);
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
      problems.push({ severity: "critical", message: "NEXT_PUBLIC_APP_URL points at localhost — canonical URLs, the sitemap and structured data would be wrong. Set your public https:// address." });
    } else if (u.protocol !== "https:") {
      problems.push({ severity: "warning", message: "NEXT_PUBLIC_APP_URL is not https://." });
    }
  } catch {
    problems.push({ severity: "critical", message: "NEXT_PUBLIC_APP_URL is not set (or not a valid URL); it defaults to localhost." });
  }

  const provider = (env.COURIER_PROVIDER ?? "none").trim().toLowerCase();
  if (provider !== "none" && provider !== "") {
    if (!env.COURIER_WEBHOOK_SECRET?.trim()) {
      problems.push({ severity: "warning", message: "COURIER_PROVIDER is set but COURIER_WEBHOOK_SECRET is not — delivery webhooks are disabled (manual refresh still works)." });
    }
    problems.push({ severity: "warning", message: `COURIER_PROVIDER="${provider}" enables API booking. The adapter is unverified against the live provider — confirm it with one real test booking first (see README → Courier integration).` });
  }
    for (const p of partiallyConfiguredProviders(env)) {
    problems.push({ severity: "warning", message: `${p} social login has only one of its two credentials set, so it stays disabled. Set both the id and the secret (see .env.example).` });
  }
  if (enabledProviders(env).length > 0 && !(env.NEXT_PUBLIC_APP_URL ?? "").startsWith("https://")) {
    problems.push({ severity: "warning", message: "Social login is enabled but NEXT_PUBLIC_APP_URL is not https:// — providers require an exact https redirect URI in production." });
  }
  if (!env.DATABASE_URL?.trim()) {
    problems.push({ severity: "critical", message: "DATABASE_URL is not set." });
  }
  // Phase 7.3: integrations that must not be switched on before verification. Messages never contain values.
  if (env.COURIER_AUTO_BOOK?.trim().toLowerCase() === "true") {
    problems.push({ severity: "warning", message: "COURIER_AUTO_BOOK=true books real parcels automatically. The courier adapter is not verified against the official documentation: keep it false until a real test parcel has been approved and checked." });
  }
  if (env.COURIER_AUTO_BOOK?.trim().toLowerCase() === "true" && (env.CRON_SECRET?.trim().length ?? 0) < 24) {
    problems.push({ severity: "warning", message: "COURIER_AUTO_BOOK=true but CRON_SECRET is missing or shorter than 24 characters, so the scheduled reconcile cannot run safely." });
  }
  if (env.BKASH_ENABLED?.trim().toLowerCase() === "true") {
    problems.push({ severity: "critical", message: "BKASH_ENABLED=true: the bKash integration is implemented from third-party documentation and has not passed official-contract review or a sandbox run. Do not accept real payments until both are done." });
    if (env.BKASH_ENV?.trim().toLowerCase() === "production") {
      problems.push({ severity: "critical", message: "BKASH_ENV=production with an unverified integration: real customer money would flow through unverified code." });
    }
  }
  const fraud = (env.FRAUD_CHECK_PROVIDER ?? "").trim().toLowerCase();
  const fraudOn = (env.FRAUD_CHECK_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const fraudProviderSet = fraud !== "" && fraud !== "none";
  if (fraudProviderSet && !(KNOWN_FRAUD_PROVIDERS as readonly string[]).includes(fraud)) {
    problems.push({ severity: "warning", message: `FRAUD_CHECK_PROVIDER is set to an unsupported value (supported: ${KNOWN_FRAUD_PROVIDERS.join(", ")}), so it is ignored and every customer gets the default trust score and the standard advance.` });
  }
  if (fraudProviderSet && fraud === "steadfast" && fraudOn) {
    // The steadfast fraud check reuses the courier credentials: report what is wrong with them (variable names only, never values).
    const courier = getCourierProviderConfig("steadfast", env);
    if (courier.problem) problems.push({ severity: "warning", message: `FRAUD_CHECK_PROVIDER=steadfast reuses the Steadfast courier credentials, but they are not usable (${courier.problem}). The fraud check will be unavailable and every customer gets the standard advance.` });
    problems.push({ severity: "warning", message: "FRAUD_CHECK_PROVIDER=steadfast: the Steadfast fraud-check response has not been verified against a live call in this project. Check one known phone number in Admin before relying on it." });
  }
  if ((env.FRAUD_CHECK_API_KEY ?? "").trim() !== "") {
    problems.push({ severity: "warning", message: fraud === "steadfast" ? "FRAUD_CHECK_API_KEY is set but the steadfast provider ignores it (it reuses STEADFAST_API_KEY / STEADFAST_API_SECRET). Remove it." : "FRAUD_CHECK_API_KEY is set but FRAUD_CHECK_PROVIDER is not a provider that uses it: the credential is unused. Remove it or select a provider." });
  }
  for (const name of ["FRAUD_CHECK_TIMEOUT_MS", "FRAUD_CHECK_CACHE_SECONDS", "FRAUD_CHECK_MAX_CALLS_PER_MINUTE"] as const) {
    const raw = (env[name] ?? "").trim();
    if (raw !== "" && !Number.isInteger(Number(raw))) problems.push({ severity: "warning", message: `${name} is not a whole number, so the built-in default is used.` });
  }
  return problems;
}
