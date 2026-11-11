// Shared, client-safe constant — kept separate from
// src/server/services/delivery.service.ts (which is "server-only" and
// reads the actual taka amounts from the database) so client components
// can use the zone labels without pulling in server-only code.
export const DELIVERY_ZONE_LABELS = {
  DHAKA_CITY: "Dhaka City",
  OUTSIDE_DHAKA: "Outside Dhaka City",
  OTHER: "Other / Outside Dhaka",
} as const;

export type DeliveryZoneKey = keyof typeof DELIVERY_ZONE_LABELS;
