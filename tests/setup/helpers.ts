/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from "node:async_hooks";
import { FakeDb, installDb } from "./fake-db";

const als: AsyncLocalStorage<{ session: any; admin: boolean }> =
  ((globalThis as any).__TEST_ALS__ ??= new AsyncLocalStorage());

/** Runs `fn` as a guest (null), a customer ({sub}), or an admin. */
export function runAs<T>(who: null | { sub: string } | "admin", fn: () => Promise<T>): Promise<T> {
  return als.run(
    who === "admin" ? { session: null, admin: true } : { session: who, admin: false },
    fn,
  );
}

export function freshDb(): FakeDb {
  const db = new FakeDb();
  installDb(db);
  return db;
}

export const emptyCheckout = {
  email: "buyer@example.com",
  phone: "+8801711000000",
  shippingAddress: {
    fullName: "Buyer One",
    phone: "+8801711000000",
    line1: "House 1, Road 2",
    city: "Dhaka",
    country: "Bangladesh",
  },
  billingSameAsShipping: true,
  billingAddress: null,
  paymentMethod: "COD" as const,
  deliveryZone: "DHAKA_CITY" as const,
  couponCode: null,
  customerNote: null,
};

/** Seeds a typical catalog and returns handy ids. */
export function seedCatalog(db: FakeDb) {
  db.insert("storeSettings", {
    id: "singleton", currencyCode: "BDT", shippingFlatRate: 0, freeShippingThreshold: null,
    taxRatePercent: 0, deliveryChargeDhaka: 70, deliveryChargeOutsideDhaka: 100, deliveryChargeOther: 150,
  });
  const standard = db.insert("product", {
    id: "p-standard", name: "Clay Vase", slug: "clay-vase", type: "STANDARD", status: "ACTIVE",
    price: 1800, costPrice: 700, stock: 5, description: "A vase for flowers",
  });
  const variantProduct = db.insert("product", {
    id: "p-variant", name: "Clay Mug", slug: "clay-mug", type: "VARIANT", status: "ACTIVE",
    price: 650, costPrice: 200, stock: 999, description: "A mug for coffee",
  });
  db.insert("productVariant", { id: "v-red", productId: "p-variant", name: "Red", sku: "MUG-R", price: 650, options: { Color: "Red" }, stock: 3 });
  db.insert("productVariant", { id: "v-blue", productId: "p-variant", name: "Blue", sku: "MUG-B", price: 700, options: { Color: "Blue" }, stock: 0 });
  const personalized = db.insert("product", {
    id: "p-pers", name: "Couple Frame", slug: "couple-frame", type: "PERSONALIZED", status: "ACTIVE",
    price: 2500, stock: 10, description: "A frame with names",
  });
  db.insert("productCustomizationField", { id: "f-name", productId: "p-pers", label: "Name", fieldKey: "name", type: "TEXT", isRequired: true, maxLength: 10, options: [] });
  db.insert("productCustomizationField", { id: "f-color", productId: "p-pers", label: "Color", fieldKey: "color", type: "SELECT", isRequired: false, options: ["Gold", "Silver"] });
  const bundle = db.insert("product", {
    id: "p-bundle", name: "Gift Box", slug: "gift-box", type: "BUNDLE", status: "ACTIVE",
    // What the migration backfills for every pre-existing bundle (behaviour-identical).
    kind: "COMBO", comboMode: "FIXED", comboPricing: "FIXED_PRICE", comboStockPolicy: "OWN_STOCK",
    price: 4500, stock: 2, description: "A box of gifts",
  });
  db.insert("productBundleItem", { id: "b-1", bundleId: "p-bundle", componentId: "p-standard", quantity: 2 });
  return { standard, variantProduct, personalized, bundle };
}

/** The Dhaka calendar day (UTC+6) `offsetDays` from now. The app dates everything in Dhaka days, so tests must too (UTC "today" is wrong from 18:00 UTC). */
export const dhakaDay = (offsetDays = 0): string => new Date(Date.now() + 6 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);

/** Real, active ADMIN users for tests that act as staff: money-state services re-check the actor, not only the server action. */
export function seedAdmins(db: FakeDb, ids: string[] = ["a1", "a2", "admin-1", "adm"]): void {
  for (const id of ids) db.insert("user", { id, email: `${id}@staff.test`, name: id, role: "ADMIN", isActive: true });
}

/** An active ADMIN present in `seedAdmins(db)` defaults. Service operations now authorise their actor inside the service, so tests that drive them must say who acts. */
export const TEST_ADMIN = { adminId: "a1" } as const;
