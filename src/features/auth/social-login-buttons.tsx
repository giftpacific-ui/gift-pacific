import { enabledProviders } from "@/lib/oauth/config";
import { REFUSE_MESSAGES } from "@/lib/oauth/linking";

const LABEL = { GOOGLE: "Google", FACEBOOK: "Facebook" } as const;

const ERRORS: Record<string, string> = {
  oauth_state: "Your sign-in session expired or could not be verified. Please try again.",
  oauth_denied: "Sign-in was cancelled. You can try again or use your email.",
  oauth_failed: "We couldn't complete sign-in with that provider. Please try again or use your email.",
  oauth_throttled: "Too many attempts. Please wait a few minutes and try again.",
  oauth_unavailable: "That sign-in method is not available right now.",
  oauth_inactive: REFUSE_MESSAGES.inactive,
  oauth_admin_email: REFUSE_MESSAGES.admin_email,
  oauth_no_email: REFUSE_MESSAGES.no_email,
  oauth_use_other_method: REFUSE_MESSAGES.use_other_method,
};

export function socialErrorMessage(code: string | undefined): string | null {
  return code ? (ERRORS[code] ?? null) : null;
}

/** Renders ONLY for providers whose credentials are configured; nothing otherwise. */
export function SocialLoginButtons({ redirectTo, error, link }: { redirectTo?: string; error?: string; link?: string }) {
  const providers = enabledProviders();
  const message = socialErrorMessage(error);
  const linking = link === "google" || link === "facebook" ? LABEL[link.toUpperCase() as keyof typeof LABEL] : null;
  if (providers.length === 0 && !message && !linking) return null;
  const qs = redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : "";
  return (
    <div className="space-y-3">
      {message && <p role="alert" className="rounded-[4px] bg-destructive/10 p-3 text-sm text-destructive">{message}</p>}
      {linking && (
        <p role="status" className="rounded-[4px] bg-secondary p-3 text-sm">
          An account with this email already exists. Sign in with your password below to connect {linking}.
        </p>
      )}
      {providers.length > 0 && (
        <>
          <div className="grid gap-2">
            {providers.map((p) => (
              // A plain link: the whole flow is server-side redirects (no provider script on our pages).
              <a key={p} href={`/api/auth/oauth/${p.toLowerCase()}/start${qs}`} className="flex h-11 items-center justify-center rounded-[4px] border border-border text-sm font-medium hover:border-foreground">
                Continue with {LABEL[p]}
              </a>
            ))}
          </div>
          <p className="text-center text-xs text-muted-foreground">or use your email</p>
        </>
      )}
    </div>
  );
}
