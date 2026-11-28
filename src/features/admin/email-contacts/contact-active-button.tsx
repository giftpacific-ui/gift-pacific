"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { setEmailContactActiveAction } from "@/server/actions/admin-email-contact.actions";

/** Activates or deactivates a contact. It changes nothing else: consent and suppression decide eligibility on their own. */
export function ContactActiveButton({ contactId, isActive, size = "sm" }: { contactId: string; isActive: boolean; size?: "sm" | "default" }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function toggle() {
    if (isActive && !confirm("Deactivate this contact? It will not be mailed while inactive. Its consent and suppression records are kept.")) return;
    start(async () => {
      const res = await setEmailContactActiveAction(contactId, !isActive);
      if (res.success) toast.success(isActive ? "Contact deactivated." : "Contact activated. Consent and suppression were not changed.");
      else toast.error(res.message);
      router.refresh();
    });
  }

  return (
    <Button type="button" variant="outline" size={size} disabled={pending} onClick={toggle}>
      {isActive ? "Deactivate" : "Activate"}
    </Button>
  );
}
