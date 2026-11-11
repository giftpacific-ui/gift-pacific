/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Minus, Plus } from "lucide-react";
import type {
  PublicCustomizationField,
  PublicProductDetail,
  PublicVariant,
} from "@/lib/product-dto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useAddToCart } from "@/features/cart/use-cart";
import { useCartUiStore } from "@/features/cart/cart-ui-store";
import { formatPrice } from "@/lib/utils";
import { MAX_QUANTITY_PER_LINE } from "@/lib/stock";
import { trackAddToCart } from "@/lib/analytics/events";

type Props = { product: PublicProductDetail };

function buildCustomizationSchema(fields: PublicCustomizationField[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let schema: z.ZodTypeAny = z.string();
    if (field.maxLength) schema = (schema as z.ZodString).max(field.maxLength);
    if (field.type === "SELECT" || field.type === "COLOR") {
      const allowed = field.options;
      schema = schema.refine(
        (v: unknown) =>
          typeof v === "string" && (v === "" || allowed.includes(v)),
        {
          message: `Choose a valid ${field.label.toLowerCase()}`,
        },
      );
    }
    if (field.isRequired) {
      schema = (schema as z.ZodString).min(1, `${field.label} is required`);
    } else {
      schema = schema.optional().or(z.literal(""));
    }
    shape[field.fieldKey] = schema;
  }
  return z.object(shape);
}

function pickInitialVariant(
  variants: PublicVariant[],
): PublicVariant | undefined {
  return (
    variants.find((v) => v.isDefault && v.inStock) ??
    variants.find((v) => v.inStock) ??
    variants.find((v) => v.isDefault) ??
    variants[0]
  );
}

export function AddToCartForm({ product }: Props) {
  const isVariantProduct = product.type === "VARIANT";
  const [quantity, setQuantity] = useState(1);
  const [selectedOptions, setSelectedOptions] = useState<
    Record<string, string>
  >(() =>
    isVariantProduct
      ? (pickInitialVariant(product.variants)?.options ?? {})
      : {},
  );

  const addToCart = useAddToCart();
  const openCart = useCartUiStore((state) => state.open);

  const optionGroups = useMemo(() => {
    const groups = new Map<string, Set<string>>();
    for (const variant of product.variants) {
      for (const [key, value] of Object.entries(variant.options)) {
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key)!.add(value);
      }
    }
    return Array.from(groups.entries()).map(([key, values]) => ({
      key,
      values: Array.from(values).map((value) => ({
        value,
        available: product.variants.some(
          (v) => v.inStock && v.options[key] === value,
        ),
      })),
    }));
  }, [product.variants]);

  const selectedVariant = useMemo<PublicVariant | null>(() => {
    if (!isVariantProduct) return null;
    const groupKeys = optionGroups.map((g) => g.key);
    return (
      product.variants.find((variant) =>
        groupKeys.every((k) => variant.options[k] === selectedOptions[k]),
      ) ?? null
    );
  }, [isVariantProduct, product.variants, optionGroups, selectedOptions]);

  const customizationSchema = useMemo(
    () => buildCustomizationSchema(product.customizationFields),
    [product.customizationFields],
  );
  const customizationForm = useForm<Record<string, unknown>>({
    resolver: product.customizationFields.length
      ? zodResolver(customizationSchema)
      : undefined,
    defaultValues: Object.fromEntries(
      product.customizationFields.map((f) => [f.fieldKey, ""]),
    ),
  });

  const availability = isVariantProduct
    ? selectedVariant
      ? {
          inStock: selectedVariant.inStock,
          maxQuantity: selectedVariant.maxQuantity,
        }
      : { inStock: false, maxQuantity: 0 }
    : product.availability;
  const outOfStock = !availability.inStock;
  const maxQuantity = Math.min(
    availability.maxQuantity ?? MAX_QUANTITY_PER_LINE,
    MAX_QUANTITY_PER_LINE,
  );
  const comboUnavailable = isVariantProduct && !selectedVariant;

  const price = selectedVariant ? selectedVariant.price : product.price;
  const compareAt =
    product.compareAtPrice !== null && product.compareAtPrice > price
      ? product.compareAtPrice
      : null;

  useEffect(() => {
    setQuantity((q) => Math.max(1, Math.min(q, Math.max(maxQuantity, 1))));
  }, [maxQuantity]);

  function handleAddToCart(customization?: Record<string, string>) {
    addToCart.mutate(
      {
        productId: product.id,
        variantId: selectedVariant?.id ?? null,
        quantity,
        customization: customization ?? null,
      },
      {
        onSuccess: (result) => {
          if (result.success) {
            openCart();
            trackAddToCart(
              {
                id: product.id,
                name: product.name,
                price,
                currency: product.currency,
              },
              quantity,
            );
          }
        },
      },
    );
  }

  const stockLabel = comboUnavailable
    ? "This combination is unavailable"
    : outOfStock
      ? "Out of stock"
      : availability.maxQuantity !== null && availability.maxQuantity <= 5
        ? `Only ${availability.maxQuantity} left`
        : "In stock";

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-3">
        <span className="font-heading text-[2rem] leading-none font-semibold">{formatPrice(price)}</span>
        {compareAt !== null && (
          <span className="text-muted-foreground line-through">
            {formatPrice(compareAt)}
          </span>
        )}
      </div>

      {optionGroups.map((group) => (
        <div key={group.key} className="space-y-2">
          <p className="text-sm font-semibold">{group.key}</p>
          <div className="flex flex-wrap gap-2">
            {group.values.map(({ value, available }) => (
              <button
                key={value}
                type="button"
                onClick={() =>
                  setSelectedOptions((prev) => ({
                    ...prev,
                    [group.key]: value,
                  }))
                }
                aria-pressed={selectedOptions[group.key] === value}
                className={`rounded-[3px] border px-4 py-2 text-sm font-medium transition-colors ${
                  selectedOptions[group.key] === value
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:border-foreground"
                } ${available ? "" : "line-through opacity-60"}`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      ))}

      {product.customizationFields.length > 0 && (
        <Form {...customizationForm}>
          <div className="space-y-4 rounded-[4px] border border-border bg-secondary p-5">
            <p className="font-heading text-xl font-semibold">Personalize this gift</p>
            {product.customizationFields.map((field) => (
              <FormField
                key={field.fieldKey}
                control={customizationForm.control}
                name={field.fieldKey}
                render={({ field: rhfField }) => (
                  <FormItem>
                    <FormLabel>
                      {field.label}
                      {!field.isRequired && (
                        <span className="text-muted-foreground">
                          {" "}
                          (optional)
                        </span>
                      )}
                    </FormLabel>
                    <FormControl>
                      {field.type === "TEXTAREA" ? (
                        <Textarea
                          maxLength={field.maxLength ?? undefined}
                          {...rhfField}
                          value={rhfField.value as string}
                        />
                      ) : field.type === "SELECT" || field.type === "COLOR" ? (
                        <Select
                          onValueChange={rhfField.onChange}
                          value={rhfField.value as string}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue
                              placeholder={`Choose ${field.label.toLowerCase()}`}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {field.options.map((opt) => (
                              <SelectItem key={opt} value={opt}>
                                {opt}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          type={field.type === "DATE" ? "date" : "text"}
                          maxLength={field.maxLength ?? undefined}
                          {...rhfField}
                          value={rhfField.value as string}
                        />
                      )}
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
        </Form>
      )}

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1 rounded-[3px] border border-border p-1">
          <button
            type="button"
            className="p-1.5 disabled:opacity-40"
            disabled={quantity <= 1 || outOfStock}
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            aria-label="Decrease quantity"
          >
            <Minus className="size-4" />
          </button>
          <span className="min-w-6 text-center">{quantity}</span>
          <button
            type="button"
            className="p-1.5 disabled:opacity-40"
            disabled={quantity >= maxQuantity || outOfStock}
            onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))}
            aria-label="Increase quantity"
          >
            <Plus className="size-4" />
          </button>
        </div>
        <p className={`text-sm ${outOfStock ? "font-medium text-destructive" : availability.maxQuantity !== null && availability.maxQuantity <= 5 ? "font-medium text-[var(--color-gold-deep)]" : "text-muted-foreground"}`} aria-live="polite">{stockLabel}</p>
      </div>

      <Button
        variant="ink"
        size="lg"
        className="h-13 w-full"
        disabled={outOfStock || addToCart.isPending}
        onClick={
          product.customizationFields.length > 0
            ? customizationForm.handleSubmit((values) =>
                handleAddToCart(values as Record<string, string>),
              )
            : () => handleAddToCart()
        }
      >
        {comboUnavailable
          ? "Unavailable"
          : outOfStock
            ? "Out of stock"
            : addToCart.isPending
              ? "Adding…"
              : "Add to cart"}
      </Button>
    </div>
  );
}
