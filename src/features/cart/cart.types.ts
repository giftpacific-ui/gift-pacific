export type CartItemDTO = {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  image: string | null;
  variantId: string | null;
  variantName: string | null;
  unitPrice: number;
  quantity: number;
  /** False when the line (variant or product, as appropriate) can't currently be bought. */
  inStock: boolean;
  /** Largest quantity this line may be set to. null = unlimited (capped at MAX_QUANTITY_PER_LINE). */
  maxQuantity: number | null;
  customization: Record<string, string> | null;
  kind: "SINGLE" | "COMBO";
  /** What a combo line contains (decided on the server); null for single products. */
  components: { name: string; variant: string | null; quantity: number; slot: string | null }[] | null;
  /** Why this line cannot currently be bought (null = fine). */
  unavailableReason: string | null;
};

export type CartDTO = {
  id: string;
  items: CartItemDTO[];
};
