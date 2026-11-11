import { CartDrawer } from "@/features/cart/cart-drawer";
import { SearchOverlay } from "@/features/search/search-overlay";
import { getStoreSettings } from "@/server/services/admin-settings.service";

/**
 * Drawer + search overlay. Every layout that renders the Navbar (shop, account, docs) must render this too,
 * otherwise the cart/search buttons set "open" state that has no drawer to show it.
 */
export async function StorefrontOverlays() {
  const settings = await getStoreSettings();
  const threshold = settings?.freeShippingThreshold ? Number(settings.freeShippingThreshold) : null;
  return (
    <>
      <CartDrawer freeShippingThreshold={threshold} />
      <SearchOverlay />
    </>
  );
}
