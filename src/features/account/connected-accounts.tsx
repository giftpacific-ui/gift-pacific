"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setInitialPasswordAction, unlinkProviderAction } from "@/server/actions/account.actions";

type Account = { provider: string; emailAtLink: string | null; linkedAt: string; canUnlink: boolean };
const NAMES: Record<string, string> = { GOOGLE: "Google", FACEBOOK: "Facebook" };

const LINK_MESSAGES: Record<string, string> = {
  linked: "Account connected.",
  already_linked: "You already have a Google/Facebook account of that type connected. Disconnect it first to use a different one.",
  taken: "That account is already connected to another customer profile, so it can't be added here.",
  not_allowed: "This account can't connect social sign-in.",
  oauth_denied: "The connection was cancelled.",
  oauth_failed: "Could not connect that account. Please try again.",
  session_changed: "You were signed out or switched accounts during the connection. Please try again.",
};

export function ConnectedAccounts({ hasPassword, accounts, available = [], status }: { hasPassword: boolean; accounts: Account[]; available?: string[]; status?: string }) {
  const [pending, start] = useTransition();
  const [pw, setPw] = useState({ newPassword: "", confirmPassword: "" });

  const connectable = available.filter((p) => !accounts.some((a) => a.provider === p));
  return (
    <div className="space-y-4">
      {status && LINK_MESSAGES[status] && <p role="status" className="rounded-lg bg-secondary px-3 py-2 text-sm">{LINK_MESSAGES[status]}</p>}
      {accounts.length === 0 && <p className="text-sm text-muted-foreground">No Google or Facebook account is connected.</p>}
      {accounts.map((a) => (
        <div key={a.provider} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3 text-sm">
          <div>
            <p className="font-medium">{NAMES[a.provider] ?? a.provider}</p>
            <p className="text-xs text-muted-foreground">{a.emailAtLink ? `${a.emailAtLink} · ` : ""}connected {new Date(a.linkedAt).toLocaleDateString()}</p>
          </div>
          <Button
            type="button" variant="outline" size="sm" disabled={pending || !a.canUnlink}
            title={a.canUnlink ? undefined : "Set a password first — this is your only way to sign in."}
            onClick={() => {
              if (!window.confirm(`Disconnect ${NAMES[a.provider] ?? a.provider}?`)) return;
              start(async () => {
                const r = await unlinkProviderAction(a.provider);
                if (r.success) toast.success("Disconnected"); else toast.error(r.message);
              });
            }}
          >Disconnect</Button>
        </div>
      ))}
      {connectable.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {connectable.map((p) => (
            // Full navigation on purpose: the route sets the OAuth cookies and redirects to the provider.
            <a key={p} href={`/api/auth/oauth/${p.toLowerCase()}/start?mode=link`} className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm hover:bg-secondary">Connect {NAMES[p] ?? p}</a>
          ))}
        </div>
      )}
      {!hasPassword && (
        <div className="space-y-2 rounded-lg border border-border/70 p-3 text-sm">
          <p className="font-medium">Add a password</p>
          <p className="text-xs text-muted-foreground">You currently sign in only with a connected account. Adding a password gives you a second way in, and lets you disconnect it later.</p>
          <Input type="password" autoComplete="new-password" placeholder="New password (min. 8 characters)" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          <Input type="password" autoComplete="new-password" placeholder="Confirm password" value={pw.confirmPassword} onChange={(e) => setPw({ ...pw, confirmPassword: e.target.value })} />
          <Button type="button" size="sm" disabled={pending} onClick={() => start(async () => {
            const r = await setInitialPasswordAction(pw);
            if (r.success) { toast.success("Password added"); setPw({ newPassword: "", confirmPassword: "" }); } else toast.error(r.message);
          })}>Save password</Button>
        </div>
      )}
    </div>
  );
}
