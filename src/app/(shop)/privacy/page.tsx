import { getPublishedSystemPage } from "@/server/services/static-page.service";
import { CmsSystemPage } from "@/components/layout/cms-system-page";
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
  // Admin-published replacement content wins; until then the built-in page below keeps rendering.
  const cms = await getPublishedSystemPage("privacy");
  if (cms) return <CmsSystemPage page={cms} />;
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
        <li>To assess delivery risk and decide whether an advance is needed. We send the phone number you enter at checkout to the delivery network (currently Steadfast) and receive counts of parcels previously delivered or cancelled for that number, which we use for this decision. We keep those counts (not the lookup response, and not the number itself in readable form) so our staff can review them, and the figures are never shown to customers. If the lookup is unavailable or there is too little history, the standard advance rule applies to your order and it is not blocked.</li>
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

      <h2>Saved checkout progress</h2>
      <p>While you fill in checkout we can save your progress (contact details, delivery details and the items in your cart) so you can resume, even if you do not place the order. This happens only while the &quot;Save my checkout progress&quot; box on the checkout page is ticked; unticking it stops saving and deletes what was saved. It never includes passwords, OTPs, card or other payment details. Unfinished checkouts are visible only to our staff, and personal details are removed automatically after a limited time (30 days by default). When you place the order the saved checkout is linked to it. We do not send reminder emails from this data.</p>

      <h2>Retention and security</h2>
      <p>We keep order records for as long as needed for accounting, returns and legal obligations. Passwords are hashed, administrative access is restricted, and payment instructions never involve sharing a PIN or OTP with us.</p>

      <h2>Contact</h2>
      <p>{s.storeName}{s.storeEmail ? ` · ${s.storeEmail}` : ""}{s.storePhone ? ` · ${s.storePhone}` : ""}{s.storeAddress ? ` · ${s.storeAddress}` : ""}</p>
      <p className="text-xs">This page describes how this site actually works. It is not legal advice; the store owner should have it reviewed for their business and update it if practices change.</p>
    </LegalPage>
  );
}
