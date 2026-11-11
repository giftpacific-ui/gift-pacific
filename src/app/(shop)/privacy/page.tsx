import type { Metadata } from "next";
import { siteConfig } from "@/config/site";
import { pageMetadata } from "@/server/services/seo.service";
import { LegalPage } from "@/components/layout/legal-page";
import { getStoreSettings } from "@/server/services/admin-settings.service";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({ title: "Privacy policy", description: `How ${siteConfig.name} collects, uses and protects your personal information.`, path: "/privacy" });
}
export const revalidate = 3600;

export default async function PrivacyPage() {
  const s = await getStoreSettings();
  return (
    <LegalPage title="Privacy Policy" updated="1 November 2026">
      <p>This policy explains what personal information {s.storeName} collects when you use this website, why, and the choices you have.</p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Orders:</strong> your name, phone number, email (if given) and delivery address, what you ordered, and any order note.</li>
        <li><strong>Account:</strong> your email and a securely hashed password, or the name and email returned by Google or Facebook if you choose to sign in with them. We never receive your Google or Facebook password.</li>
        <li><strong>Advance payments:</strong> the wallet (bKash or Nagad) and the transaction id you enter. We never ask for, receive or store a wallet PIN or OTP.</li>
        <li><strong>Reviews, messages and applications:</strong> what you submit through the review, contact and careers forms.</li>
        <li><strong>Technical data:</strong> a session cookie and a cart cookie that make sign-in and your cart work, and — only if you accept — analytics cookies.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To take, confirm, deliver and support your orders, and to keep records the law requires.</li>
        <li>To assess delivery risk and decide whether an advance is needed. If a delivery-network fraud-check service is connected, we send the phone number you enter at checkout to it and receive counts of parcels previously delivered, cancelled or returned across couriers. We use those counts only for this decision, and we keep the counts (not the lookup response) with the order for our staff. They are never shown to customers. No such service is connected at the moment: nothing is looked up, and the standard advance rule applies to everyone. If a service is connected but unavailable, the same standard rule applies and your order is not blocked.</li>
        <li>To issue and redeem delivery rewards linked to your account.</li>
        <li>To improve the site, if you accept analytics cookies.</li>
      </ul>

      <h2>Who receives it</h2>
      <ul>
        <li><strong>Couriers</strong> receive your name, phone number, address and the amount to collect so they can deliver your parcel.</li>
        <li><strong>Hosting and database providers</strong> store the data on our behalf.</li>
        <li><strong>Image hosting (Cloudinary)</strong> stores product and site images only, not customer data.</li>
        <li><strong>Google and Facebook</strong> receive a sign-in request only if you choose those options. Analytics services (such as Google Analytics, Meta Pixel, TikTok or LinkedIn) load only after you accept.</li>
      </ul>
      <p>We do not sell your personal information.</p>

      <h2>Your choices</h2>
      <ul>
        <li>You can accept or decline analytics cookies in the cookie banner and change your mind at any time by clearing the site&apos;s cookies.</li>
        <li>You can view and edit your profile and addresses in your account, and disconnect a Google or Facebook sign-in there (you must keep another way to sign in).</li>
        <li>To ask for a copy of your data, a correction or deletion, contact us below. We may keep records we are legally required to keep, such as order and payment records.</li>
      </ul>

      <h2>Retention and security</h2>
      <p>We keep order records for as long as needed for accounting, returns and legal obligations. Passwords are hashed, administrative access is restricted, and payment instructions never involve sharing a PIN or OTP with us.</p>

      <h2>Contact</h2>
      <p>{s.storeName}{s.storeEmail ? ` · ${s.storeEmail}` : ""}{s.storePhone ? ` · ${s.storePhone}` : ""}{s.storeAddress ? ` · ${s.storeAddress}` : ""}</p>
      <p className="text-xs">This page describes how this site actually works. It is not legal advice; the store owner should have it reviewed for their business and update it if practices change.</p>
    </LegalPage>
  );
}
