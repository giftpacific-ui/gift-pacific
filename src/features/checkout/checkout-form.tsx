"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { checkoutSchema, type CheckoutInput } from "@/lib/validations/checkout";
import { checkCoupon, submitCheckout, getDeliveryChargesAction, getAdvanceQuoteAction } from "@/server/actions/checkout.actions";
import { quoteDeliveryReward } from "@/lib/rewards";
import { useCart, useInvalidateCart } from "@/features/cart/use-cart";
import { getCartTotals } from "@/features/cart/cart-totals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { formatPrice } from "@/lib/utils";
import { trackAddPaymentInfo, trackInitiateCheckout } from "@/lib/analytics/events";
import { DELIVERY_ZONE_LABELS } from "@/lib/delivery-zones";

const emptyAddress = {
  fullName: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "Bangladesh",
};

export function CheckoutForm({
  savedProfile,
  savedAddresses = [],
  rewards = [],
}: {
  savedProfile?: { email: string; phone: string } | null;
  savedAddresses?: {
    id: string;
    fullName: string;
    phone: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string | null;
    postalCode: string | null;
    country: string;
  }[];
  rewards?: { id: string; percent: number; maxDiscount: number | null; minOrderAmount: number; stackable: boolean }[];
} = {}) {
  const router = useRouter();
  const { data: cart } = useCart();
  const invalidateCart = useInvalidateCart();
  const { data: deliveryCharges } = useQuery({
    queryKey: ["delivery-charges"],
    queryFn: () => getDeliveryChargesAction(),
  });
  const [isPending, startTransition] = useTransition();
  const [advanceMethod, setAdvanceMethod] = useState<"BKASH" | "NAGAD" | "">("");
  const [advanceReference, setAdvanceReference] = useState("");
  const [couponState, setCouponState] = useState<
    { code: string; discountAmount: number } | null
  >(null);
  const [couponInput, setCouponInput] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);
  const [checkingCoupon, setCheckingCoupon] = useState(false);
  const [rewardId, setRewardId] = useState<string>("");
  const [useProfileInfo, setUseProfileInfo] = useState(false);
  const [selectedAddressId, setSelectedAddressId] = useState<string>("");

  function handleUseProfileInfo(checked: boolean) {
    setUseProfileInfo(checked);
    if (checked && savedProfile) {
      if (savedProfile.email) form.setValue("email", savedProfile.email, { shouldValidate: true });
      if (savedProfile.phone) form.setValue("phone", savedProfile.phone, { shouldValidate: true });
    }
  }

  function handleUseSavedAddress(addressId: string) {
    setSelectedAddressId(addressId);
    const address = savedAddresses.find((a) => a.id === addressId);
    if (!address) return;
    form.setValue(
      "shippingAddress",
      {
        fullName: address.fullName,
        phone: address.phone,
        line1: address.line1,
        line2: address.line2 ?? "",
        city: address.city,
        state: address.state ?? "",
        postalCode: address.postalCode ?? "",
        country: address.country,
      },
      { shouldValidate: true },
    );
  }

  const items = cart?.items ?? [];
  const { subtotal } = getCartTotals(items);
  const discount = couponState?.discountAmount ?? 0;

  const form = useForm<CheckoutInput>({
    resolver: zodResolver(checkoutSchema),
    defaultValues: {
      email: "",
      phone: "",
      shippingAddress: emptyAddress,
      billingSameAsShipping: true,
      paymentMethod: "COD",
      deliveryZone: "DHAKA_CITY",
      couponCode: "",
      rewardId: "",
      customerNote: "",
    },
  });

  const billingSameAsShipping = form.watch("billingSameAsShipping");
  const paymentMethod = form.watch("paymentMethod");
  const deliveryZone = form.watch("deliveryZone");
  const deliveryCharge = deliveryCharges?.[deliveryZone] ?? 0;
  const { data: advanceQuote } = useQuery({
    queryKey: ["advance-quote", deliveryZone],
    queryFn: () => getAdvanceQuoteAction(deliveryZone),
  });
  // Preview only — the server recomputes eligibility and the amount from the stored reward terms.
  const chosenReward = rewards.find((r) => r.id === rewardId) ?? null;
  const rewardQuote = chosenReward
    ? quoteDeliveryReward(chosenReward, { deliveryCharge, subtotalAfterCoupon: Math.max(subtotal - discount, 0), couponApplied: Boolean(couponState) })
    : null;
  const rewardDiscount = rewardQuote?.ok ? rewardQuote.discount : 0;
  const estimatedTotal = Math.max(subtotal - discount, 0) + Math.max(deliveryCharge - rewardDiscount, 0);

  // Each checkout-funnel event is sent once per visit to this page — not again
  // when the cart reloads, an item is removed, or React re-runs the effect.
  const sentPaymentInfo = useRef(false);
  const sentInitiateCheckout = useRef(false);

  useEffect(() => {
    if (sentPaymentInfo.current) return;
    sentPaymentInfo.current = true;
    trackAddPaymentInfo(paymentMethod);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (items.length > 0 && !sentInitiateCheckout.current) {
      sentInitiateCheckout.current = true;
      trackInitiateCheckout(
        items.map((i) => ({ id: i.productId, name: i.productName, price: i.unitPrice })),
        subtotal,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  async function handleApplyCoupon() {
    if (!couponInput.trim()) return;
    setCheckingCoupon(true);
    setCouponError(null);
    const result = await checkCoupon(couponInput);
    setCheckingCoupon(false);
    if (!result.valid) {
      setCouponError(result.message);
      setCouponState(null);
      return;
    }
    setCouponState({ code: couponInput.toUpperCase(), discountAmount: result.discountAmount });
    form.setValue("couponCode", couponInput);
    toast.success("Coupon applied");
  }

  function onSubmit(values: CheckoutInput) {
    startTransition(async () => {
      const result = await submitCheckout(values);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      // Only after the server confirmed the order: refresh the cart everywhere (drawer, header count).
      await invalidateCart();
      router.push(`/checkout/confirmation/${result.orderNumber}`);
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-10 lg:grid-cols-3">
        <div className="space-y-8 lg:col-span-2">
          <section className="space-y-4">
            <h2 className="font-heading text-2xl font-semibold">Contact information</h2>
            {savedProfile && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={useProfileInfo} onCheckedChange={handleUseProfileInfo} />
                Use my profile information
              </label>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone</FormLabel>
                    <FormControl>
                      <Input type="tel" inputMode="tel" autoComplete="tel" placeholder="01XXXXXXXXX or +8801XXXXXXXXX" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="font-heading text-2xl font-semibold">Shipping address</h2>
            {savedAddresses.length > 0 && (
              <Select value={selectedAddressId} onValueChange={handleUseSavedAddress}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Use a saved address…" />
                </SelectTrigger>
                <SelectContent>
                  {savedAddresses.map((address) => (
                    <SelectItem key={address.id} value={address.id}>
                      {address.fullName} — {address.line1}, {address.city}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <AddressFields namePrefix="shippingAddress" />
          </section>

          <section className="space-y-4">
            <h2 className="font-heading text-2xl font-semibold">Delivery zone</h2>
            <FormField
              control={form.control}
              name="deliveryZone"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(DELIVERY_ZONE_LABELS) as (keyof typeof DELIVERY_ZONE_LABELS)[]).map(
                          (zone) => (
                            <SelectItem key={zone} value={zone}>
                              {DELIVERY_ZONE_LABELS[zone]}
                              {deliveryCharges ? ` — ${formatPrice(deliveryCharges[zone])}` : ""}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          <section className="space-y-3">
            <FormField
              control={form.control}
              name="billingSameAsShipping"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center gap-2 space-y-0">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <FormLabel className="font-normal">Billing address is the same as shipping</FormLabel>
                </FormItem>
              )}
            />
            {!billingSameAsShipping && (
              <div className="space-y-4 pt-2">
                <h3 className="font-heading text-2xl font-semibold">Billing address</h3>
                <AddressFields namePrefix="billingAddress" />
              </div>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="font-heading text-2xl font-semibold">Payment method</h2>
            <FormField
              control={form.control}
              name="paymentMethod"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div className="flex items-center gap-3 rounded-lg border border-primary bg-primary/5 p-4">
                      <input type="hidden" {...field} value="COD" />
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-primary">
                        <span className="size-2.5 rounded-full bg-primary" />
                      </span>
                      <div>
                        <p className="text-sm font-medium">Cash on Delivery</p>
                        <p className="text-xs text-muted-foreground">
                          Pay in cash when your order arrives.
                        </p>
                      </div>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          {advanceQuote && advanceQuote.required > 0 && (
            <section className="space-y-3 rounded-lg border border-border/70 p-4 text-sm" aria-labelledby="advance-title">
              <h2 id="advance-title" className="font-medium">Advance payment: {formatPrice(Math.min(advanceQuote.required, estimatedTotal))}</h2>
              <p className="text-muted-foreground">
                This delivery area needs an advance before we confirm your order. It is <strong>part of your total</strong>, not an extra charge — the rest
                ({formatPrice(Math.max(estimatedTotal - Math.min(advanceQuote.required, estimatedTotal), 0))}) is paid on delivery.
              </p>
              {advanceQuote.instructions && <p className="whitespace-pre-line rounded bg-secondary/60 p-2">{advanceQuote.instructions}</p>}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1">Sent with
                  <select value={advanceMethod} onChange={(e) => { const v = e.target.value as "BKASH" | "NAGAD" | ""; setAdvanceMethod(v); form.setValue("advanceMethod", v === "" ? undefined : v); }} className="h-10 rounded-md border border-input bg-background px-3">
                    <option value="">Choose…</option><option value="BKASH">bKash</option><option value="NAGAD">Nagad</option>
                  </select>
                </label>
                <label className="grid gap-1">Transaction ID
                  <input value={advanceReference} maxLength={60} onChange={(e) => { setAdvanceReference(e.target.value); form.setValue("advanceReference", e.target.value); }} className="h-10 rounded-md border border-input bg-background px-3" />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">We check this against our wallet statement before confirming your order. Never share a PIN or OTP.</p>
            </section>
          )}

          <section className="space-y-2">
            <FormField
              control={form.control}
              name="customerNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Order notes (optional)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Delivery instructions, gift notes, etc." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>
        </div>

        <div className="h-fit space-y-4 rounded-[4px] border border-border bg-card p-6">
          <h2 className="font-heading text-2xl font-semibold">Order summary</h2>
          <div className="max-h-64 space-y-3 overflow-y-auto">
            {items.map((item) => (
              <div key={item.id} className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {item.productName} × {item.quantity}
                </span>
                <span>{formatPrice(item.unitPrice * item.quantity)}</span>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Coupon code"
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value)}
            />
            <Button type="button" variant="outline" onClick={handleApplyCoupon} disabled={checkingCoupon}>
              Apply
            </Button>
          </div>
          {couponError && <p className="text-sm text-destructive">{couponError}</p>}
          {couponState && (
            <p className="text-sm text-success">
              Coupon {couponState.code} applied: -{formatPrice(couponState.discountAmount)}
            </p>
          )}

          {rewards.length > 0 && (
            <div className="space-y-2 rounded-lg border border-border/70 p-3 text-sm">
              <p className="font-medium">Your delivery rewards</p>
              {rewards.map((r) => {
                const checked = rewardId === r.id;
                const quote = quoteDeliveryReward(r, { deliveryCharge, subtotalAfterCoupon: Math.max(subtotal - discount, 0), couponApplied: Boolean(couponState) });
                return (
                  <label key={r.id} className="flex items-start gap-2">
                    <input
                      type="checkbox" checked={checked} disabled={!quote.ok && !checked}
                      onChange={(e) => { const next = e.target.checked ? r.id : ""; setRewardId(next); form.setValue("rewardId", next); }}
                    />
                    <span>
                      {r.percent}% off delivery{r.maxDiscount !== null ? ` (up to ${formatPrice(r.maxDiscount)})` : ""}
                      <span className="block text-xs text-muted-foreground">
                        {quote.ok ? `Saves ${formatPrice(quote.discount)} on this order.`
                          : quote.reason === "below_minimum" ? `Needs an order of at least ${formatPrice(r.minOrderAmount)}.`
                          : quote.reason === "no_stacking" ? "Cannot be combined with a coupon."
                          : "Delivery is already free."}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="space-y-1 border-t border-border pt-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatPrice(subtotal)}</span>
            </div>
            {discount > 0 && (
              <div className="flex justify-between text-success">
                <span>Discount</span>
                <span>-{formatPrice(discount)}</span>
              </div>
            )}
            <div className="flex justify-between text-muted-foreground">
              <span>Delivery ({DELIVERY_ZONE_LABELS[deliveryZone]})</span>
              <span>{formatPrice(deliveryCharge)}</span>
            </div>
            {rewardDiscount > 0 && (
              <div className="flex justify-between text-success">
                <span>Delivery reward</span>
                <span>-{formatPrice(rewardDiscount)}</span>
              </div>
            )}
          </div>
          <div className="flex justify-between border-t border-border pt-3 text-base font-medium">
            <span>Estimated total</span>
            <span>{formatPrice(estimatedTotal)}</span>
          </div>

          <Button type="submit" variant="ink" size="lg" className="h-13 w-full" disabled={isPending || items.length === 0}>
            {isPending ? "Placing order…" : "Place order"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

function AddressFields({ namePrefix }: { namePrefix: "shippingAddress" | "billingAddress" }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        name={`${namePrefix}.fullName`}
        render={({ field }) => (
          <FormItem className="sm:col-span-2">
            <FormLabel>Full name</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name={`${namePrefix}.phone`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Phone</FormLabel>
            <FormControl>
              <Input type="tel" inputMode="tel" autoComplete="tel" placeholder="01XXXXXXXXX or +8801XXXXXXXXX" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name={`${namePrefix}.country`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Country</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name={`${namePrefix}.line1`}
        render={({ field }) => (
          <FormItem className="sm:col-span-2">
            <FormLabel>Address line 1</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name={`${namePrefix}.line2`}
        render={({ field }) => (
          <FormItem className="sm:col-span-2">
            <FormLabel>Address line 2 (optional)</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name={`${namePrefix}.city`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>City</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name={`${namePrefix}.state`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>State / Province (optional)</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name={`${namePrefix}.postalCode`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Postal code (optional)</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
