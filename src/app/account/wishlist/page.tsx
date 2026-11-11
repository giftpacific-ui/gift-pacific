import type { Metadata } from "next";
import { getWishlistEntries } from "@/server/services/wishlist.service";
import { WishlistItemCard } from "@/features/wishlist/wishlist-item-card";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata: Metadata = { title: "My Wishlist" };

export default async function WishlistPage() {
  const { available: products, unavailable } = await getWishlistEntries();

  return (
    <div>
      <h1 className="mb-6 font-heading text-2xl">Wishlist</h1>
      {products.length === 0 && unavailable.length === 0 ? (
        <EmptyState
          title="Your wishlist is empty"
          description="Save pieces you love to find them here later."
        />
      ) : (
        <div className="space-y-3">
          {products.map((product) => (
            <WishlistItemCard key={product.id} product={product} />
          ))}
          {unavailable.map((item) => (
            <WishlistItemCard key={item.productId} unavailable={item} />
          ))}
        </div>
      )}
    </div>
  );
}
