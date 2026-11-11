import { NextResponse, type NextRequest } from "next/server";
import { parseProvider, providerConfig } from "@/lib/oauth/config";
import { fetchProfile } from "@/lib/oauth/providers";
import {
  OAUTH_COOKIE_MAX_AGE, OAUTH_LINK_COOKIE, OAUTH_STATE_COOKIE, readOAuthState, safeEqual, signPendingLink,
} from "@/lib/oauth/state";
import { completeOAuthLogin, linkProviderToUser } from "@/server/services/oauth.service";
import { getCurrentUser } from "@/lib/auth/current-user";
import { establishCustomerSession, mergeGuestCartIfPresent } from "@/lib/auth/establish-session";
import { isSafeRelativePath } from "@/lib/url-safety";
import { logServerError } from "@/lib/logger";

export const dynamic = "force-dynamic";

function done(req: NextRequest, to: string) {
  const res = NextResponse.redirect(new URL(to, req.url));
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/api/auth/oauth", maxAge: 0 }); // single use
  return res;
}
const fail = (req: NextRequest, error: string) => done(req, `/login?error=${error}`);

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const provider = parseProvider((await params).provider);
  if (!provider || !providerConfig(provider)) return new NextResponse(null, { status: 404 });

  // 1) The state cookie proves this callback belongs to a flow THIS browser started.
  const saved = await readOAuthState(req.cookies.get(OAUTH_STATE_COOKIE)?.value);
  const stateParam = req.nextUrl.searchParams.get("state") ?? "";
  if (!saved || saved.provider !== provider || !stateParam || !safeEqual(saved.state, stateParam)) {
    return fail(req, "oauth_state");
  }

  // Connect-another-account flow: failures go back to the settings page, never to login.
  const linking = Boolean(saved.linkUserId);
  const failHere = (code: string) => (linking ? done(req, `/account/settings?link=${code}`) : fail(req, code));

  // 2) The user declined, or the provider reported a problem.
  if (req.nextUrl.searchParams.get("error")) return failHere("oauth_denied");
  const code = req.nextUrl.searchParams.get("code");
  if (!code || code.length > 2048) return failHere("oauth_failed");

  if (saved.linkUserId) {
    // The browser that STARTED the link must still be signed in as the same customer.
    const me = await getCurrentUser();
    if (!me || me.id !== saved.linkUserId) return failHere("session_changed");
    try {
      const profile = await fetchProfile(provider, { code, verifier: saved.verifier, nonce: saved.nonce });
      const result = await linkProviderToUser(me.id, provider, profile);
      return done(req, `/account/settings?link=${result.status === "linked" ? "linked" : result.reason}`);
    } catch (error) {
      logServerError("oauth.link", error instanceof Error ? new Error(error.message) : error, { provider });
      return failHere("oauth_failed");
    }
  }

  try {
    // 3) Server-to-server exchange + verification (never trust browser-supplied identity).
    const profile = await fetchProfile(provider, { code, verifier: saved.verifier, nonce: saved.nonce });
    const outcome = await completeOAuthLogin(provider, profile);

    if (outcome.status === "refused") return fail(req, `oauth_${outcome.reason}`);

    if (outcome.status === "needs_password") {
      // An account with this email already exists and has a password: connect only after they
      // prove ownership by signing in with it (see loginUser).
      const res = done(req, `/login?link=${provider.toLowerCase()}`);
      res.cookies.set(OAUTH_LINK_COOKIE, await signPendingLink({ provider, providerAccountId: profile.providerAccountId, email: outcome.email }), {
        httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: OAUTH_COOKIE_MAX_AGE,
      });
      return res;
    }

    await establishCustomerSession(outcome.user);
    await mergeGuestCartIfPresent(outcome.user.id);
    return done(req, isSafeRelativePath(saved.redirectTo) ? saved.redirectTo : "/account");
  } catch (error) {
    // Log the failure class only: never the code, tokens or provider payload.
    logServerError("oauth.callback", error instanceof Error ? new Error(error.message) : error, { provider });
    return fail(req, "oauth_failed");
  }
}
