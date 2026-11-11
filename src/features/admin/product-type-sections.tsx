"use client";

import { useState, type ReactNode } from "react";
import { ProductEditorDirtyProvider } from "@/features/admin/product-editor-dirty";
import { ProductForm } from "@/features/admin/product-form";
import { ProductVariantsManager } from "@/features/admin/product-variants-manager";
import { ProductCustomizationManager } from "@/features/admin/product-customization-manager";
import { ProductBundleManager, type BundleItemWithComponent } from "@/features/admin/product-bundle-manager";
import { ComboSlotsManager, type ComboSlotView } from "@/features/admin/combo-slots-manager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Product, ProductVariant, ProductCustomizationField } from "@prisma/client";

export function ProductTypeSections({
  product,
  categories,
  variants,
  customizationFields,
    bundleItems,
  comboSlots,
  attributesPanel,
  stockPanel,
  mediaPanel,
  galleryImages,
}: {
  product: Product;
  categories: { id: string; name: string; depth: number }[];
  variants: ProductVariant[];
  customizationFields: ProductCustomizationField[];
  bundleItems: BundleItemWithComponent[];
  comboSlots: ComboSlotView[];
  attributesPanel: ReactNode;
  stockPanel: ReactNode;
  mediaPanel: ReactNode;
  galleryImages?: { url: string }[];
}) {
  const [active, setActive] = useState<string>("basic");
  // Starts from the saved product.type, but updates live as the admin
  // changes the Type dropdown in ProductForm — the sections below react to
  // this, not to the server-rendered product.type, which is what makes
  // them appear/disappear immediately instead of only after a save.
  const [type, setType] = useState<Product["type"]>(product.type);
  const [comboMode, setComboMode] = useState<Product["comboMode"]>(product.comboMode);

  return (
    <ProductEditorDirtyProvider>
      <Card>
        <CardHeader>
          <CardTitle>Product details</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductForm product={product} categories={categories} galleryImages={galleryImages} extraTabs={[{ key: "variants", label: "Variants & attributes" }, { key: "media", label: "Media" }]} activeTab={active} onTabChange={setActive} onTypeChange={(t, mode) => { setType(t); setComboMode(mode); }} />
        </CardContent>
      </Card>
      <span id="product-sections" className="scroll-mt-24" aria-hidden />

      {/* Panels stay mounted (only hidden) so unsaved drafts inside the managers survive tab switches. */}
      <div id="tab-panel-inventory-extra" role="tabpanel" aria-labelledby="tab-inventory" hidden={active !== "inventory"} className="space-y-8">
        {stockPanel}
      </div>
      <div id="tab-panel-media" role="tabpanel" aria-labelledby="tab-media" hidden={active !== "media"} className="space-y-8">
        {mediaPanel}
      </div>
      <div id="tab-panel-variants" role="tabpanel" aria-labelledby="tab-variants" hidden={active !== "variants"} className="space-y-8">
        <>
          {attributesPanel}

      {type === "VARIANT" && (
        <Card>
          <CardHeader>
            <CardTitle>Variants</CardTitle>
          </CardHeader>
          <CardContent>
            <ProductVariantsManager
              productId={product.id}
              variants={variants}
              basePrice={Number(product.price)}
              baseStock={product.stock}
            />
          </CardContent>
        </Card>
      )}

      {type === "PERSONALIZED" && (
        <Card>
          <CardHeader>
            <CardTitle>Personalization fields</CardTitle>
          </CardHeader>
          <CardContent>
            <ProductCustomizationManager productId={product.id} fields={customizationFields} />
          </CardContent>
        </Card>
      )}

      {type === "BUNDLE" && comboMode !== "CUSTOMIZABLE" && (
        <Card>
          <CardHeader>
            <CardTitle>Combo contents</CardTitle>
          </CardHeader>
          <CardContent>
            <ProductBundleManager bundleId={product.id} items={bundleItems} />
          </CardContent>
        </Card>
      )}

      {type === "BUNDLE" && comboMode === "CUSTOMIZABLE" && (
        <Card>
          <CardHeader>
            <CardTitle>Selection groups</CardTitle>
          </CardHeader>
          <CardContent>
            <ComboSlotsManager comboId={product.id} slots={comboSlots} categories={categories} />
          </CardContent>
        </Card>
      )}
        </>
      </div>
    </ProductEditorDirtyProvider>
  );
}
