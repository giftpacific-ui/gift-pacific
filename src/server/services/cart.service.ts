import "server-only";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/current-user";
import { getOrCreateGuestToken } from "@/lib/cart/guest-token";
import {
  isValidQuantity,
  maxOrderableQuantity,
  MAX_QUANTITY_PER_LINE,
  resolveLineStock,
  totalQuantityFor,
  validateVariantSelection,
} from "@/lib/stock";
import { sellableCustomizationFields, validateCustomizationInput } from "@/lib/customization";
import { UserFacingError } from "@/lib/errors";
import { assertDemandFits, resolveCartLines, type CartLineInput } from "@/server/services/combo.service";
import type { CartDTO, CartItemDTO } from "@/features/cart/cart.types";
import type { Prisma } from "@prisma/client";

const cartInclude = {
  items: {
    include: {
      product: {
        include: { images: { where: { isMain: true }, take: 1 }, variants: true },
      },
      variant: true,
      selections: true,
    },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.CartInclude;

type CartWithItems = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

function readCustomization(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

type CartItemRow = CartWithItems["items"][number];

function toLine(item: CartItemRow): CartLineInput {
  return {
    id: item.id,
    productId: item.productId,
    variantId: item.variantId,
    quantity: item.quantity,
    product: item.product,
    variant: item.variant,
    selections: item.selections.map((s) => ({ slotId: s.slotId, optionId: s.optionId, quantity: s.quantity })),
  };
}

/**
 * Builds the cart DTO. Prices, availability and combo contents are decided on the
 * SERVER by the shared resolver — never taken from what was stored at add time.
 */
async function toCartDTO(cart: CartWithItems): Promise<CartDTO> {
  const resolved = await resolveCartLines(prisma, cart.items.map(toLine));
  const byId = new Map(resolved.map((r) => [r.lineId, r]));
  const items: CartItemDTO[] = cart.items.map((item) => {
    const r = byId.get(item.id)!;
    const image = item.variant?.image ?? item.product.images[0]?.url ?? null;
    return {
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      productSlug: item.product.slug,
      image,
      variantId: item.variantId,
      variantName: item.variant?.name ?? null,
      unitPrice: r.unitPrice,
      quantity: item.quantity,
      inStock: r.unavailableReason === null,
      maxQuantity: r.maxQuantity,
      customization: readCustomization(item.customization),
      kind: item.product.kind,
      components: r.combo
        ? r.combo.resolution.components.map((c) => ({
            name: c.productName,
            variant: c.variantName,
            quantity: c.quantity,
            slot: c.slotLabel,
          }))
        : null,
      unavailableReason: r.unavailableReason,
    };
  });
  return { id: cart.id, items };
}

/**
 * Throws if the cart — with `quantities` applied to existing lines and an optional extra
 * candidate line — would need more of any component than is in stock, counting every
 * line together.
 */
async function assertCartFits(
  items: CartItemRow[],
  quantities: Map<string, number>,
  candidate?: { line: CartLineInput; quantity: number },
) {
  const lines = items.map(toLine);
  const all = candidate ? [...lines, candidate.line] : lines;
  const resolved = await resolveCartLines(prisma, all);
  const entries = all.map((line, i) => ({
    quantity: candidate && i === all.length - 1 ? candidate.quantity : (quantities.get(line.id) ?? line.quantity),
    resolved: resolved[i],
  }));
  assertDemandFits(entries);
}

/** Resolves (and lazily creates) the cart for the current visitor — logged in or guest. */
export async function getOrCreateCartForCurrentVisitor() {
  const session = await getSession();

  if (session) {
    const cart = await prisma.cart.upsert({
      where: { userId: session.sub },
      update: {},
      create: { userId: session.sub },
      include: cartInclude,
    });
    return cart;
  }

  const guestToken = await getOrCreateGuestToken();
  const cart = await prisma.cart.upsert({
    where: { guestToken },
    update: {},
    create: { guestToken },
    include: cartInclude,
  });
  return cart;
}

export async function getCurrentCartDTO(): Promise<CartDTO> {
  const cart = await getOrCreateCartForCurrentVisitor();
  return toCartDTO(cart);
}

/**
 * Adds a COMBO. A customizable combo's selection is validated against its template on the
 * server (slots, options, min/max, per-item limits, availability); the price is computed
 * there too. Identical selections merge into one line.
 */
async function addComboToCart(
  cart: CartWithItems,
  product: CartLineInput["product"],
  input: AddToCartInput,
): Promise<CartDTO> {
  if (input.variantId) throw new UserFacingError("This product is not currently available.");
  const candidate: CartLineInput = {
    id: "candidate",
    productId: product.id,
    variantId: null,
    quantity: input.quantity,
    product,
    variant: null,
    // Untrusted: resolveCombo() validates its shape and every id/quantity in it.
    selections: input.selections as CartLineInput["selections"],
  };
  const existingLines = cart.items.map(toLine);
  const resolved = await resolveCartLines(prisma, [...existingLines, candidate]);
  const candidateResolved = resolved[resolved.length - 1];
  if (candidateResolved.unavailableReason || !candidateResolved.combo) {
    throw new UserFacingError(candidateResolved.unavailableReason ?? "This combo is not currently available.");
  }
  const { resolution } = candidateResolved.combo;
  const targetIndex = cart.items.findIndex(
    (l, i) => l.productId === product.id && resolved[i].combo?.resolution.selectionKey === resolution.selectionKey,
  );
  const target = targetIndex >= 0 ? cart.items[targetIndex] : null;
  const newQuantity = (target?.quantity ?? 0) + input.quantity;
  if (newQuantity > MAX_QUANTITY_PER_LINE) {
    throw new UserFacingError(`You can order at most ${MAX_QUANTITY_PER_LINE} of one item.`);
  }
  await assertCartFits(
    cart.items,
    new Map(target ? [[target.id, newQuantity]] : []),
    target ? undefined : { line: candidate, quantity: input.quantity },
  );
  if (target) {
    await prisma.cartItem.update({ where: { id: target.id }, data: { quantity: newQuantity } });
  } else {
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: product.id,
        variantId: null,
        quantity: input.quantity,
        // Store the VALIDATED selection, not the raw input.
        selections: {
          create: resolution.components
            .filter((c) => c.slotId && c.optionId)
            .map((c) => ({ slotId: c.slotId!, optionId: c.optionId!, quantity: c.quantity })),
        },
      },
    });
  }
  return getCurrentCartDTO();
}

type AddToCartInput = {
  productId: string;
  variantId?: string | null;
  quantity: number;
  /** Untrusted client input — validated against the product's configured fields. */
  customization?: unknown;
  /** Untrusted client input for a customizable combo: [{ slotId, optionId, quantity }]. */
  selections?: unknown;
};

export async function addItemToCart(input: AddToCartInput): Promise<CartDTO> {
  if (typeof input.productId !== "string" || !input.productId) {
    throw new UserFacingError("This product is not currently available.");
  }
  if (!isValidQuantity(input.quantity)) {
    throw new UserFacingError(`Please choose a quantity between 1 and ${MAX_QUANTITY_PER_LINE}.`);
  }

  const cart = await getOrCreateCartForCurrentVisitor();

  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    include: { variants: true, customizationFields: { orderBy: { sortOrder: "asc" } } },
  });
  if (!product || product.status !== "ACTIVE") {
    throw new UserFacingError("This product is not currently available.");
  }

  if (product.kind === "COMBO") return addComboToCart(cart, product, input);

  const variantId = input.variantId ?? null;
  const variant = variantId ? (product.variants.find((v) => v.id === variantId) ?? null) : null;
  const selectionError = validateVariantSelection({
    productType: product.type,
    variantId,
    variantBelongsToProduct: variant !== null,
  });
  if (selectionError) throw new UserFacingError(selectionError);

  const customization = validateCustomizationInput(sellableCustomizationFields(product), input.customization);
  if (!customization.ok) throw new UserFacingError(customization.message);

  const stockFields = resolveLineStock({
    trackInventory: product.trackInventory,
    product,
    variant,
  });
  const maxQuantity = maxOrderableQuantity(stockFields);

  const lines = await prisma.cartItem.findMany({ where: { cartId: cart.id } });
  const alreadyInCart = totalQuantityFor(lines, product.id, variant?.id ?? null);
  if (alreadyInCart + input.quantity > maxQuantity) {
    throw new UserFacingError(
      maxQuantity <= 0
        ? "This item is out of stock."
        : stockFields.allowBackorder && stockFields.stock < maxQuantity
          ? `Only ${maxQuantity} can be ordered right now.`
          : `Only ${stockFields.stock} left in stock.`,
    );
  }

  // A component may also be part of a combo already in the cart: count every line together.
  if (cart.items.some((l) => l.product.kind === "COMBO")) {
    const target = lines.find(
      (l) =>
        l.productId === product.id &&
        (l.variantId ?? null) === (variant?.id ?? null) &&
        readCustomization(l.customization) === null,
    );
    await assertCartFits(
      cart.items,
      new Map(target && customization.value === null ? [[target.id, target.quantity + input.quantity]] : []),
      target && customization.value === null
        ? undefined
        : {
            line: { id: "candidate", productId: product.id, variantId: variant?.id ?? null, quantity: input.quantity, product, variant, selections: [] },
            quantity: input.quantity,
          },
    );
  }
  // Lines with personalization are never merged — each customization is
  // unique. A plain add merges only into an existing plain line.
  const mergeTarget =
    customization.value === null
      ? lines.find(
          (l) =>
            l.productId === product.id &&
            (l.variantId ?? null) === (variant?.id ?? null) &&
            readCustomization(l.customization) === null,
        )
      : undefined;

  if (mergeTarget) {
    const merged = mergeTarget.quantity + input.quantity;
    if (merged > MAX_QUANTITY_PER_LINE) {
      throw new UserFacingError(`You can order at most ${MAX_QUANTITY_PER_LINE} of one item.`);
    }
    await prisma.cartItem.update({ where: { id: mergeTarget.id }, data: { quantity: merged } });
  } else {
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: product.id,
        variantId: variant?.id ?? null,
        quantity: input.quantity,
        customization: customization.value ?? undefined,
      },
    });
  }

  return getCurrentCartDTO();
}

export async function updateCartItemQuantity(
  cartItemId: string,
  quantity: number,
): Promise<CartDTO> {
  if (typeof quantity !== "number" || !Number.isInteger(quantity)) {
    throw new UserFacingError("Please choose a valid quantity.");
  }

  const cart = await getOrCreateCartForCurrentVisitor();
  const item = await prisma.cartItem.findFirst({
    where: { id: cartItemId, cartId: cart.id },
    include: { product: true, variant: true },
  });
  if (!item) throw new UserFacingError("Cart item not found.");

  if (quantity <= 0) {
    await prisma.cartItem.delete({ where: { id: cartItemId } });
    return getCurrentCartDTO();
  }
  if (!isValidQuantity(quantity)) {
    throw new UserFacingError(`You can order at most ${MAX_QUANTITY_PER_LINE} of one item.`);
  }
  if (item.product.type === "VARIANT" && !item.variant) {
    throw new UserFacingError("This option is no longer available. Please remove it from your cart.");
  }
  // Combos, and any single that is a component of a combo in the cart, are checked against
  // the WHOLE cart's stock demand (a shared component is counted once, with every line).
  if (item.product.kind === "COMBO" || cart.items.some((l) => l.product.kind === "COMBO")) {
    const resolved = await resolveCartLines(prisma, cart.items.map(toLine));
    const own = resolved[cart.items.findIndex((l) => l.id === item.id)];
    if (own?.unavailableReason && quantity > item.quantity) {
      throw new UserFacingError(own.unavailableReason);
    }
    await assertCartFits(cart.items, new Map([[item.id, quantity]]));
    await prisma.cartItem.update({ where: { id: cartItemId }, data: { quantity } });
    return getCurrentCartDTO();
  }

  const stockFields = resolveLineStock({
    trackInventory: item.product.trackInventory,
    product: item.product,
    variant: item.variant,
  });
  const maxQuantity = maxOrderableQuantity(stockFields);

  const lines = await prisma.cartItem.findMany({ where: { cartId: cart.id } });
  const otherLines = lines.filter((l) => l.id !== item.id);
  const others = totalQuantityFor(otherLines, item.productId, item.variantId);
  if (others + quantity > maxQuantity) {
    throw new UserFacingError(
      maxQuantity <= 0
        ? "This item is out of stock."
        : stockFields.allowBackorder && stockFields.stock < maxQuantity
          ? `Only ${maxQuantity} can be ordered right now.`
          : `Only ${stockFields.stock} left in stock.`,
    );
  }

  await prisma.cartItem.update({
    where: { id: cartItemId },
    data: { quantity },
  });

  return getCurrentCartDTO();
}

export async function removeCartItem(cartItemId: string): Promise<CartDTO> {
  const cart = await getOrCreateCartForCurrentVisitor();
  await prisma.cartItem.deleteMany({
    where: { id: cartItemId, cartId: cart.id },
  });
  return getCurrentCartDTO();
}

/** Merges a guest cart into a user's cart right after login/registration. */
export async function mergeGuestCartIntoUserCart(
  userId: string,
  guestToken: string,
) {
  const guestCart = await prisma.cart.findUnique({
    where: { guestToken },
    include: { items: { include: { selections: true } } },
  });
  if (!guestCart || guestCart.items.length === 0) return;

  const userCart = await prisma.cart.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });

  for (const item of guestCart.items) {
    const isPlain = readCustomization(item.customization) === null && item.selections.length === 0;
    // Only plain lines merge; personalized and customized-combo lines are always kept as-is.
    const candidates = isPlain
      ? await prisma.cartItem.findMany({
          where: {
            cartId: userCart.id,
            productId: item.productId,
            variantId: item.variantId,
          },
        })
      : [];
    const existing = candidates.find((c) => readCustomization(c.customization) === null);

    if (existing) {
      await prisma.cartItem.update({
        where: { id: existing.id },
        data: { quantity: Math.min(existing.quantity + item.quantity, MAX_QUANTITY_PER_LINE) },
      });
    } else {
      await prisma.cartItem.create({
        data: {
          cartId: userCart.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: Math.min(item.quantity, MAX_QUANTITY_PER_LINE),
          customization: item.customization ?? undefined,
          selections: {
            create: item.selections.map((sel) => ({ slotId: sel.slotId, optionId: sel.optionId, quantity: sel.quantity })),
          },
        },
      });
    }
  }

  await prisma.cart.delete({ where: { id: guestCart.id } });
}
