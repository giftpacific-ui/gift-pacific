import type { OAuthProviderName } from "@/lib/oauth/linking";

/**
 * Provider credentials come ONLY from server-side environment variables (never NEXT_PUBLIC_*,
 * never the database). A provider is enabled only when BOTH its id and secret are set AND the
 * public site URL is known (the redirect URI is built from it) — otherwise its button is not
 * rendered and its routes answer 404. Nothing pretends to work without credentials.
 */
export const PROVIDERS: OAuthProviderName[] = ["GOOGLE", "FACEBOOK"];

type Env = Record<string, string | undefined>;

const ENV_KEYS: Record<OAuthProviderName, { id: string; secret: string }> = {
  GOOGLE: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  FACEBOOK: { id: "FACEBOOK_APP_ID", secret: "FACEBOOK_APP_SECRET" },
};

export function appBaseUrl(env: Env = process.env): string | null {
  const raw = env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function providerConfig(provider: OAuthProviderName, env: Env = process.env) {
  const keys = ENV_KEYS[provider];
  const clientId = env[keys.id]?.trim();
  const clientSecret = env[keys.secret]?.trim();
  const base = appBaseUrl(env);
  if (!clientId || !clientSecret || !base) return null;
  return { clientId, clientSecret, redirectUri: `${base}/api/auth/oauth/${provider.toLowerCase()}/callback` };
}

export function enabledProviders(env: Env = process.env): OAuthProviderName[] {
  return PROVIDERS.filter((p) => providerConfig(p, env) !== null);
}

export function parseProvider(value: string): OAuthProviderName | null {
  const upper = value.toUpperCase();
  return (PROVIDERS as string[]).includes(upper) ? (upper as OAuthProviderName) : null;
}

/** Half-configured providers (id without secret, etc.) — reported by the production checks. */
export function partiallyConfiguredProviders(env: Env = process.env): OAuthProviderName[] {
  return PROVIDERS.filter((p) => {
    const keys = ENV_KEYS[p];
    const set = [env[keys.id]?.trim(), env[keys.secret]?.trim()].filter(Boolean).length;
    return set === 1;
  });
}
