import type { Metadata } from "next";
import { siteConfig } from "@/config/site";
import { pageMetadata } from "@/server/services/seo.service";
import { getAllDeliveryCharges, DELIVERY_ZONE_LABELS } from "@/server/services/delivery.service";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { formatPrice } from "@/lib/utils";
import Link from "next/link";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({ title: "Shipping & returns", description: `Delivery areas, charges and delivery times, plus how returns work at ${siteConfig.name}.`, path: "/shipping-returns" });
}

export default async function ShippingReturnsPage() {
  const [charges, settings] = await Promise.all([getAllDeliveryCharges(), getStoreSettings()]);
  const freeShippingThreshold = settings.freeShippingThreshold
    ? Number(settings.freeShippingThreshold)
    : null;

  const zones: Array<keyof typeof DELIVERY_ZONE_LABELS> = ["DHAKA_CITY", "OUTSIDE_DHAKA", "OTHER"];

  return (
    <div className="container-boutique py-12">
      <div className="mx-auto max-w-2xl">
        <h1 className="font-heading text-[clamp(2.2rem,4.5vw,3.4rem)] leading-tight font-semibold">Shipping &amp; Returns</h1>

        <section className="mt-10 space-y-4">
          <h2 className="font-heading text-xl">Delivery charges</h2>
          <p className="text-muted-foreground">
            Delivery charges depend on where your order is being shipped within Bangladesh:
          </p>
          <div className="overflow-hidden rounded-xl border border-border/70">
            <table className="w-full text-sm">
              <tbody>
                {zones.map((zone) => (
                  <tr key={zone} className="border-b border-border/70 last:border-0">
                    <td className="p-3 font-medium">{DELIVERY_ZONE_LABELS[zone]}</td>
                    <td className="p-3 text-right text-muted-foreground">
                      {formatPrice(charges[zone])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {freeShippingThreshold !== null && (
            <p className="text-sm text-muted-foreground">
              Orders over {formatPrice(freeShippingThreshold)} qualify for free delivery,
              regardless of zone.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Orders are typically delivered within 3–7 business days depending on your location.
            Once your order ships, its courier and tracking details appear on your order page in your account.
          </p>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="font-heading text-xl">Returns &amp; exchanges</h2>
          <p className="text-muted-foreground">
            Because most of our pieces are handmade or made to order, we handle returns on a
            case-by-case basis:
          </p>
          <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
            <li>
              If an item arrives damaged or defective, contact us within 3 days of delivery with
              a photo and your order number, and we&apos;ll arrange a replacement or refund.
            </li>
            <li>
              Standard (non-personalized) items in original, unused condition can be returned
              within 7 days of delivery.
            </li>
            <li>
              Personalized or made-to-order items cannot be returned or exchanged unless they
              arrive damaged or defective, since they&apos;re made specifically for you.
            </li>
            <li>Return shipping costs are the customer&apos;s responsibility unless the item was faulty.</li>
          </ul>
          <p className="text-muted-foreground">
            To start a return, please reach out through our{" "}
            <Link href="/contact" className="text-primary hover:underline">
              Contact page
            </Link>{" "}
            with your order number.
          </p>
        </section>
      </div>
    </div>
  );
}
