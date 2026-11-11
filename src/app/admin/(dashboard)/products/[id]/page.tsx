import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminGetProductById } from "@/server/services/admin-product.service";
import { adminGetProductAttributeData } from "@/server/services/attribute.service";
import { ProductAttributesCard } from "@/features/admin/product-attributes-card";
import { adminListComboSlots } from "@/server/services/admin-combo.service";
import { adminListCategoriesForSelect } from "@/server/services/admin-category.service";
import { ProductGalleryManager } from "@/features/admin/product-gallery-manager";
import { ProductTypeSections } from "@/features/admin/product-type-sections";
import { serializeDecimals } from "@/lib/serialize";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StockAdjustmentCard } from "@/features/admin/stock-adjustment-card";
import { listStockAdjustments } from "@/server/services/stock-adjustment.service";

export const metadata: Metadata = { title: "Edit Product · Admin" };

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [rawProduct, categories, adjustments, comboSlots, attributeData] = await Promise.all([
    adminGetProductById(id),
    adminListCategoriesForSelect(),
    listStockAdjustments(id),
        adminListComboSlots(id),
    adminGetProductAttributeData(id),
  ]);
  if (!rawProduct) notFound();
  // Serialized once here and reused for every client component below —
  // rawProduct.price/compareAtPrice/costPrice, variants[].price, and
  // bundleItems[].component.price/compareAtPrice are all Prisma Decimal
  // values that can't cross the Server -> Client boundary as-is.
  const product = serializeDecimals(rawProduct);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8">
      <h1 className="font-heading text-2xl">{product.name}</h1>

      {/*
        ProductTypeSections is a client component that holds its own
        "type" state, starting from product.type but updating live as the
        admin changes the Type dropdown inside ProductForm (which it also
        renders) — that's what makes Variants/Personalization/Bundle
        appear immediately instead of only after a save+refresh.
      */}
      <ProductTypeSections
        product={product}
        categories={categories}
        variants={product.variants}
        customizationFields={product.customizationFields}
        bundleItems={product.bundleItems}
        comboSlots={comboSlots}
        galleryImages={product.images.map((i) => ({ url: i.url }))}
        attributesPanel={(
<Card id="attributes" className="scroll-mt-24">
        <CardHeader>
          <CardTitle>Attributes</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductAttributesCard productId={product.id} defs={attributeData.defs} current={attributeData.current} />
        </CardContent>
      </Card>
        )}
        stockPanel={(
<Card>
        <CardHeader>
          <CardTitle>Stock adjustment &amp; history</CardTitle>
        </CardHeader>
        <CardContent>
          <StockAdjustmentCard
            productId={product.id}
            isVariantProduct={product.type === "VARIANT"}
            variants={product.variants.map((v) => ({ id: v.id, name: v.name, stock: v.stock }))}
            stock={product.stock}
            history={adjustments.map((a) => ({
              id: a.id,
              delta: a.delta,
              stockAfter: a.stockAfter,
              reason: a.reason,
              createdAt: a.createdAt,
              variantName: a.variant?.name ?? null,
            }))}
          />
        </CardContent>
      </Card>
        )}
        mediaPanel={(
<Card>
        <CardHeader>
          <CardTitle>Images</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductGalleryManager
            productId={product.id}
            productName={product.name}
            images={product.images}
          />
        </CardContent>
      </Card>
        )}
      />
    </div>
  );
}
