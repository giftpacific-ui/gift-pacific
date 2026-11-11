import type { Metadata } from "next";
import { CheckoutForm } from "@/features/checkout/checkout-form";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getAddressesForCurrentUser } from "@/server/services/address.service";
import { listRewardsForUser } from "@/server/services/reward.service";

export const metadata: Metadata = { title: "Checkout", robots: { index: false, follow: false } };

export default async function CheckoutPage() {
  const user = await getCurrentUser();
  const addresses = user ? await getAddressesForCurrentUser() : [];
  // Only the signed-in customer's OWN, currently usable rewards are ever sent to the browser.
  const rewards = user ? (await listRewardsForUser(user.id)).filter((r) => r.status === "AVAILABLE") : [];

  return (
    <div className="container-boutique pt-10 pb-8 sm:pt-16">
      <p className="eyebrow">Almost there</p>
      <h1 className="mb-8 font-heading text-[clamp(2.2rem,4.5vw,3.4rem)] leading-tight font-semibold sm:mb-12">Checkout</h1>
      <CheckoutForm
        savedProfile={user ? { email: user.email, phone: user.phone ?? "" } : null}
        savedAddresses={addresses}
        rewards={rewards.map((r) => ({ id: r.id, percent: r.percent, maxDiscount: r.maxDiscount, minOrderAmount: r.minOrderAmount, stackable: r.stackable }))}
      />
    </div>
  );
}
