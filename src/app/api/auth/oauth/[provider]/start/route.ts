import { NextResponse, type NextRequest } from "next/server";
import { parseProvider, providerConfig } from "@/lib/oauth/config";
import { buildAuthorizeUrl } from "@/lib/oauth/providers";
import { OAUTH_COOKIE_MAX_AGE, OAUTH_STATE_COOKIE, newPkce, newRandom, signOAuthState } from "@/lib/oauth/state";
import { RATE_LIMITS, clientAddress, consumeRateLimit } from "@/lib/rate-limit";
import { isSafeRelativePath } from "@/lib/url-safety";
import { getCurrentUser } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

const back = (req: NextRequest, error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, req.url));

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const provider = parseProvider((await params).provider);
  // Unknown or unconfigured provider: it simply does not exist.
  if (!provider || !providerConfig(provider)) return new NextResponse(null, { status: 404 });

  const throttle = await consumeRateLimit(RATE_LIMITS.oauthStart, [await clientAddress()]);
  if (!throttle.ok) return back(req, "oauth_throttled");

  // "Connect another account": only for a signed-in, active customer (never admins).
  let linkUserId: string | undefined;
  if (req.nextUrl.searchParams.get("mode") === "link") {
    const me = await getCurrentUser();
    if (!me) return NextResponse.redirect(new URL("/login?redirect=/account/settings", req.url));
    if (await prisma.oAuthAccount.findFirst({ where: { userId: me.id, provider }, select: { id: true } })) {
      return NextResponse.redirect(new URL("/account/settings?link=already_linked", req.url));
    }
    linkUserId = me.id;
  }

  const requested = req.nextUrl.searchParams.get("redirect") ?? "";
  const redirectTo = isSafeRelativePath(requested) ? requested : "/account";

  const { verifier, challenge } = newPkce();
  const state = newRandom();
  const nonce = newRandom();
  const url = buildAuthorizeUrl(provider, { state, nonce, challenge });
  if (!url) return new NextResponse(null, { status: 404 });

  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, await signOAuthState({ provider, state, nonce, verifier, redirectTo, ...(linkUserId ? { linkUserId } : {}) }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // the provider redirects back with a top-level GET
    path: "/api/auth/oauth",
    maxAge: OAUTH_COOKIE_MAX_AGE,
  });
  return res;
}
