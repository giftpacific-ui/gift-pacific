import "server-only";
import { prisma } from "@/lib/db/prisma";
import type { DeliveryZone } from "@prisma/client";

export { DELIVERY_ZONE_LABELS } from "@/lib/delivery-zones";

/**
 * The single place in the codebase that turns a delivery zone into a taka
 * amount. Every place that needs a delivery charge (checkout, order
 * creation, invoices) should call this rather than hardcoding 70/100/150,
 * so changing the rates in /admin/settings takes effect everywhere at once.
 */
export async function getDeliveryCharge(zone: DeliveryZone): Promise<number> {
  const settings = await prisma.storeSettings.findUnique({ where: { id: "singleton" } });
  if (!settings) {
    // Sensible defaults matching schema defaults, in case settings row
    // somehow doesn't exist yet (shouldn't happen once seeded).
    const fallback: Record<DeliveryZone, number> = {
      DHAKA_CITY: 70,
      OUTSIDE_DHAKA: 100,
      OTHER: 150,
    };
    return fallback[zone];
  }

  const byZone: Record<DeliveryZone, number> = {
    DHAKA_CITY: Number(settings.deliveryChargeDhaka),
    OUTSIDE_DHAKA: Number(settings.deliveryChargeOutsideDhaka),
    OTHER: Number(settings.deliveryChargeOther),
  };
  return byZone[zone];
}

export async function getAllDeliveryCharges(): Promise<Record<DeliveryZone, number>> {
  const settings = await prisma.storeSettings.findUnique({ where: { id: "singleton" } });
  return {
    DHAKA_CITY: settings ? Number(settings.deliveryChargeDhaka) : 70,
    OUTSIDE_DHAKA: settings ? Number(settings.deliveryChargeOutsideDhaka) : 100,
    OTHER: settings ? Number(settings.deliveryChargeOther) : 150,
  };
}
