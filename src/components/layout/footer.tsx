import Link from "next/link";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { getCategoryTree } from "@/server/services/product.service";
import { getActiveCampaign } from "@/server/services/campaign.service";
import { siteConfig } from "@/config/site";
import { isSafeHttpUrl } from "@/lib/url-safety";

const colHeading = "mb-4 font-heading text-lg font-semibold";
const footLink = "text-[0.95rem] text-secondary transition-colors hover:text-primary focus-visible:text-primary";

/**
 * Footer. Every detail shown here comes from Admin → Settings or the
 * database: contact details and social links appear ONLY when the store has
 * entered them, categories are the real ones, and there is no newsletter
 * form (there is no subscription backend, so it would only pretend).
 */
export async function Footer() {
  const [settings, categories, campaign] = await Promise.all([getStoreSettings(), getCategoryTree(), getActiveCampaign()]);
  const storeName = settings?.storeName || siteConfig.name;

  const socials = [
    { label: "Instagram", href: settings?.instagramUrl },
    { label: "Facebook", href: settings?.facebookUrl },
    { label: "TikTok", href: settings?.tiktokUrl },
    { label: "WhatsApp", href: settings?.whatsappUrl },
  ].filter((s): s is { label: string; href: string } => Boolean(s.href) && isSafeHttpUrl(s.href as string));

  const email = settings?.storeEmail || null;
  const phone = settings?.storePhone || null;
  const address = settings?.storeAddress || null;

  return (
    <footer className="bg-primary text-secondary pt-14 pb-8 print:hidden sm:pt-20" aria-label="Site footer">
     <div className="container mx-auto px-3">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1.2fr] lg:gap-12">
          <div>
            <Link href="/" className="inline-flex items-center gap-2 font-heading text-2xl font-bold">
              {storeName}
              <span aria-hidden className="size-2 rotate-45 bg-primary" />
            </Link>
            <p className="mt-4 max-w-xs text-[0.95rem] text-secondary">{siteConfig.description}</p>
            {socials.length > 0 && (
              <ul className="mt-5 flex flex-wrap gap-2" aria-label="Social media">
                {socials.map((s) => (
                  <li key={s.label}>
                    <a
                      href={s.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-9 items-center rounded-full border border-border px-4 text-sm text-secondary transition-colors hover:border-foreground hover:bg-foreground hover:text-background"
                    >
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <nav aria-label="Shop">
            <h2 className={colHeading}>Shop</h2>
            <ul className="grid gap-2.5">
              <li><Link href="/shop" className={footLink}>All products</Link></li>
              {campaign && <li><Link href="/campaign" className={footLink}>{campaign.name}</Link></li>}
              {categories.slice(0, 5).map((c) => (
                <li key={c.id}><Link href={`/shop/${c.slug}`} className={footLink}>{c.name}</Link></li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Help">
            <h2 className={colHeading}>Help</h2>
            <ul className="grid gap-2.5">
              <li><Link href="/boxes" className={footLink}>Our Boxes</Link></li>
              <li><Link href="/build-your-own-combo" className={footLink}>Build your own combo</Link></li>
              <li><Link href="/about-us" className={footLink}>Our story</Link></li>
              <li><Link href="/shipping-returns" className={footLink}>Shipping &amp; returns</Link></li>
              <li><Link href="/terms" className={footLink}>Terms of service</Link></li>
              <li><Link href="/privacy" className={footLink}>Privacy policy</Link></li>
              <li><Link href="/contact" className={footLink}>Contact us</Link></li>
              <li><Link href="/career" className={footLink}>Careers</Link></li>
              <li><Link href="/account/orders" className={footLink}>Track an order</Link></li>
            </ul>
          </nav>

          <div>
            <h2 className={colHeading}>Get in touch</h2>
            {email || phone || address ? (
              <address className="grid gap-2.5 text-[0.95rem] text-secondary not-italic">
                {email && <a href={`mailto:${email}`} className={footLink}>{email}</a>}
                {phone && <a href={`tel:${phone.replace(/[^+\d]/g, "")}`} className={footLink}>{phone}</a>}
                {address && <span>{address}</span>}
              </address>
            ) : (
              <p className="text-[0.95rem] text-secondary">
                Questions about an order or a gift? <Link href="/contact" className="link-underline text-foreground">Send us a message</Link>.
              </p>
            )}
          </div>
        </div>

        <div className="mt-12 flex flex-col justify-between gap-2 border-t border-border pt-6 text-sm text-secondary sm:flex-row">
          <p>
            &copy; {new Date().getFullYear()} {storeName}. All rights reserved.
          </p>
          <p>Cash on delivery</p>
        </div>
      </div>
    </footer>
  );
}
