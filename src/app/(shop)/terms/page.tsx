import type { Metadata } from "next";
import { siteConfig } from "@/config/site";
import { pageMetadata } from "@/server/services/seo.service";
import Link from "next/link";
import { LegalPage } from "@/components/layout/legal-page";
import { getStoreSettings } from "@/server/services/admin-settings.service";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({ title: "Terms of service", description: `The terms that apply when you order from ${siteConfig.name}.`, path: "/terms" });
}
export const revalidate = 3600;

export default async function TermsPage() {
  const s = await getStoreSettings();
  return (
    <LegalPage title="Terms of Service" updated="1 November 2026">
      <p>These terms apply when you order from {s.storeName} through this website. By placing an order you agree to them.</p>

      <h2>Orders and prices</h2>
      <ul>
        <li>Prices are in Bangladeshi Taka (BDT). The price and total shown at checkout are calculated by our system when you place the order; the delivery charge depends on your delivery area.</li>
        <li>An order is a request to buy. We confirm it after checking stock and, where required, your advance payment. We may decline or cancel an order, for example if an item is unavailable, and will refund anything you have paid for it.</li>
        <li>Some items may be sourced after you order. When that applies, the product page or your order will say so and delivery is dispatched once the item reaches us.</li>
      </ul>

      <h2>Payment</h2>
      <ul>
        <li>Orders are normally paid by cash on delivery (COD).</li>
        <li>For some delivery areas we ask for an advance before confirming. The advance is part of your total, not an extra fee; the remaining balance is paid on delivery. An advance only counts once we have verified the transaction in our wallet statement.</li>
        <li>Never share a wallet PIN or OTP with anyone, including us.</li>
      </ul>

      <h2>Delivery, returns and refunds</h2>
      <p>Delivery times, return conditions and refunds are described on our <Link className="underline underline-offset-4" href="/shipping-returns">Shipping &amp; Returns</Link> page, which forms part of these terms. Please check your parcel on arrival and contact us promptly about damage or errors.</p>

      <h2>Accounts, rewards and coupons</h2>
      <ul>
        <li>Keep your account details secure; you are responsible for activity under your account.</li>
        <li>Delivery rewards and coupons have the conditions shown when they are issued (for example expiry, minimum order, or whether they can be combined). They have no cash value and may be withdrawn if the order that earned them is refunded.</li>
      </ul>

      <h2>Reviews and content</h2>
      <p>Reviews may be moderated. Do not post unlawful, abusive or misleading content.</p>

      <h2>Liability and changes</h2>
      <p>We take care to describe products accurately; photos and colours may vary slightly. To the extent the law allows, our liability for an order is limited to its value. We may update these terms; the version in force when you order applies to that order. Bangladeshi law governs these terms.</p>

      <h2>Contact</h2>
      <p>{s.storeName}{s.storeEmail ? ` · ${s.storeEmail}` : ""}{s.storePhone ? ` · ${s.storePhone}` : ""}</p>
      <p className="text-xs">This page is a plain-language statement of how this store operates. It is not legal advice; the store owner should have it reviewed for their business.</p>
    </LegalPage>
  );
}
