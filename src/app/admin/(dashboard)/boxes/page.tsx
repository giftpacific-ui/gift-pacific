import type { Metadata } from "next";
import { adminListBoxes } from "@/server/services/box.service";
import { BoxManager, type BoxRow } from "@/features/admin/box-manager";

export const metadata: Metadata = { title: "Boxes · Admin" };

export default async function AdminBoxesPage() {
  const boxes = await adminListBoxes();
  const rows: BoxRow[] = boxes.map((b) => ({
    id: b.id, name: b.name, slug: b.slug, description: b.description, imageUrl: b.imageUrl, imagePublicId: b.imagePublicId,
    price: Number(b.price), sortOrder: b.sortOrder, isActive: b.isActive, managed: Boolean(b.product?.isBoxProduct), legacyLinked: Boolean(b.productId && !b.product?.isBoxProduct),
    stock: b.product?.isBoxProduct ? b.product.stock : 0, allowBackorder: b.product?.isBoxProduct ? b.product.allowBackorder : false,
    seoTitle: b.seoTitle, seoDescription: b.seoDescription, seoKeywords: b.seoKeywords ?? [],
  }));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Boxes</h1>
        <p className="text-sm text-muted-foreground">
          Gift boxes shown on the public <strong>Our Boxes</strong> page. Each box has its own price and stock; customers can buy it on its own or
          pick it inside a build-your-own combo. Inactive or out-of-stock boxes cannot be bought.
        </p>
      </div>
      <BoxManager boxes={rows} />
    </div>
  );
}
