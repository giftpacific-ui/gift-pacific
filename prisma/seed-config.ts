/**
 * Seed configuration, resolved from the environment. Pure (no I/O) so the
 * rules are unit-tested (tests/unit/seed-config.test.ts, seed-runner.test.ts).
 *
 * POLICY — admin-only, fail closed
 *  The seed creates EXACTLY ONE thing: an admin user with credentials supplied
 *  via SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD. No store settings, no demo
 *  customer, no categories, no products, no coupons, no banners, no orders.
 *  Everything else is created from the admin panel after going live.
 *
 *  Rules:
 *    - SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must BOTH be set explicitly.
 *      There is no development default; a missing or blank value is an error.
 *    - SEED_ADMIN_PASSWORD must be strong: >= 12 chars, at least one
 *      lower-case, one upper-case and one digit, not a known default, and
 *      must not contain the email's local-part (>= 4 chars).
 *    - All of this is validated BEFORE a database client is created, so an
 *      unsafe configuration cannot cause a single database write.
 *    - An existing user is never modified (handled in seed-runner.ts).
 *    - Passwords, secrets and database URLs are never part of any message.
 */
export const MIN_ADMIN_PASSWORD = 12;

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db", "postgres", "host.docker.internal"]);
// Query parameters that can redirect the connection somewhere other than the URL's host.
const HOST_OVERRIDE_PARAMS = ["host", "hostaddr", "socket", "service"];
const POSTGRES_PROTOCOLS = new Set(["postgresql:", "postgres:"]);

/** How far a DATABASE_URL can be trusted as a disposable local database. */
export type DatabaseTrust = "verified-local" | "remote" | "unknown";

/**
 * Conservative classification. Only a parseable postgres URL whose host is on
 * the local allow-list (and has no host-override query parameter) is
 * "verified-local". Missing or unparseable URLs are "unknown"; everything else
 * is "remote". Both non-local results are treated identically by the policy.
 */
export function classifyDatabase(databaseUrl: string | undefined): DatabaseTrust {
  const raw = clean(databaseUrl);
  if (!raw) return "unknown";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "unknown";
  }
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) return "unknown";
  if (!url.hostname) return "unknown";
  for (const key of HOST_OVERRIDE_PARAMS) {
    if (url.searchParams.has(key)) return "unknown";
  }
  return LOCAL_HOSTS.has(url.hostname.toLowerCase()) ? "verified-local" : "remote";
}

/** True only when DATABASE_URL is positively identified as a local database. */
export function isLocalDatabase(databaseUrl: string | undefined): boolean {
  return classifyDatabase(databaseUrl) === "verified-local";
}

export type SeedConfig = {
  /** NODE_ENV=production (informational only). */
  isProduction: boolean;
  databaseTrust: DatabaseTrust;
  adminEmail: string;
  adminPassword: string;
  warnings: string[];
};

export type SeedConfigResult = { ok: true; config: SeedConfig } | { ok: false; errors: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lower-cased, compared case-insensitively.
const KNOWN_DEFAULT_PASSWORDS = new Set(["password123!", "changeme123!", "changeme123", "admin1234567"]);

export function isStrongPassword(password: string, email?: string): boolean {
  if (password.length < MIN_ADMIN_PASSWORD) return false;
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) return false;
  if (KNOWN_DEFAULT_PASSWORDS.has(password.toLowerCase())) return false;
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return false;
  return true;
}

export function resolveSeedConfig(env: Env): SeedConfigResult {
  const nodeEnv = clean(env.NODE_ENV)?.toLowerCase() ?? null;
  const isProduction = nodeEnv === "production";
  const databaseTrust = classifyDatabase(env.DATABASE_URL);
  const email = clean(env.SEED_ADMIN_EMAIL)?.toLowerCase() ?? null; // app lower-cases emails at login
  const password = clean(env.SEED_ADMIN_PASSWORD);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!email) {
    errors.push("SEED_ADMIN_EMAIL must be set explicitly (blank counts as unset).");
  } else if (!EMAIL.test(email)) {
    errors.push("SEED_ADMIN_EMAIL is not a valid email address.");
  }

  if (!password) {
    errors.push("SEED_ADMIN_PASSWORD must be set explicitly (blank counts as unset).");
  } else if (!isStrongPassword(password, email ?? undefined)) {
    errors.push(
      `SEED_ADMIN_PASSWORD is too weak: use at least ${MIN_ADMIN_PASSWORD} characters with lower-case, upper-case and a digit, not a known default and not containing the email name.`,
    );
  }

  if (databaseTrust !== "verified-local" && !isProduction) {
    warnings.push(
      "DATABASE_URL does not look like a local database. Proceeding because SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are explicitly set — but double-check you are pointing at the intended database.",
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      isProduction,
      databaseTrust,
      adminEmail: email!,
      adminPassword: password!,
      warnings,
    },
  };
}