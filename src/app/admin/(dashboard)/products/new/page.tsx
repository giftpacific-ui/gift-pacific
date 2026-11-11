import type { Metadata } from "next";
import { adminListCategoriesForSelect } from "@/server/services/admin-category.service";
import { adminListAttributeDefs } from "@/server/services/attribute.service";
import { ProductCreateFlow } from "@/features/admin/product-create-flow";

export const metadata: Metadata = { title: "New Product · Admin" };

export default async function NewProductPage() {
  const [categories, defs] = await Promise.all([adminListCategoriesForSelect(), adminListAttributeDefs()]);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <h1 className="font-heading text-2xl">New product</h1>
      <ProductCreateFlow categories={categories} defs={defs} />
      <p className="text-sm text-muted-foreground">
        Variants, attributes, personalization fields and images you add here are kept until you publish, then saved with
        the product. Combo contents and bundle items link to other saved records, so they are added once the product exists.
      </p>
    </div>
  );
}
