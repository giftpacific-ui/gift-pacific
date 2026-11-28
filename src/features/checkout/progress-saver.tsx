"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { UseFormReturn } from "react-hook-form";
import Link from "next/link";
import { Checkbox } from "@/components/ui/checkbox";
import type { CheckoutInput } from "@/lib/validations/checkout";
import { discardCheckoutProgressAction, saveCheckoutProgressAction } from "@/server/actions/checkout-progress.actions";

export type RecoveryNotice = { enabled: boolean; /** false under an opt-in consent mode: the box starts unticked */ defaultOn: boolean };

/**
 * Autosaves checkout progress (debounced) once the customer has agreed. Only a WHITELIST of fields is ever sent (contact, address, zone, coupon code,
 * the attempt key): never the note, billing address, advance method/reference, or anything payment related. Failures are silent.
 */
export function useCheckoutProgressSaver(opts: {
  form: UseFormReturn<CheckoutInput>;
  notice: RecoveryNotice;
  checkoutKey: string;
  cartSignature: string;
  submitted: RefObject<boolean>;
}) {
  const { form, notice, checkoutKey, cartSignature, submitted } = opts;
  const [enabled, setEnabled] = useState(notice.enabled && notice.defaultOn);
  const everSaved = useRef(false);

  useEffect(() => {
    if (!notice.enabled || !enabled || !cartSignature) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      if (submitted.current) return; // the order is being placed: never save over it
      const v = form.getValues();
      if (!v.email && !v.phone) return;
      const a = v.shippingAddress;
      everSaved.current = true;
      void saveCheckoutProgressAction({
        consent: true,
        email: v.email || undefined,
        phone: v.phone || undefined,
        deliveryZone: v.deliveryZone,
        couponCode: v.couponCode || undefined,
        checkoutKey: checkoutKey || undefined,
        shippingAddress: { fullName: a.fullName, line1: a.line1, line2: a.line2 || undefined, city: a.city, state: a.state || undefined, postalCode: a.postalCode || undefined, country: a.country },
      });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(send, 2000);
    };
    const sub = form.watch(schedule);
    schedule();
    return () => {
      sub.unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, notice.enabled, form, checkoutKey, cartSignature, submitted]);

  function setConsent(next: boolean) {
    setEnabled(next);
    if (!next && everSaved.current) {
      everSaved.current = false;
      void discardCheckoutProgressAction(); // withdrawing deletes what was saved
    }
  }
  return { enabled, setConsent };
}

export function CheckoutProgressNotice({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 rounded-[4px] border border-border/70 bg-secondary/30 p-3 text-sm">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <span>
        Save my checkout progress so I can resume if I leave. If ticked, your contact details, delivery details and cart are saved as you type, even if you don&apos;t place the order.
        They are kept for a limited time and never include passwords, OTPs or payment details. Untick to stop and delete what was saved.{" "}
        <Link href="/privacy" className="underline">Privacy policy</Link>
      </span>
    </label>
  );
}
