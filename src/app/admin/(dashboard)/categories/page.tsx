import type { Metadata } from "next";
import { adminListCategories } from "@/server/services/admin-category.service";
import { CategoryFormDialog } from "@/features/admin/category-form-dialog";
import { DeleteCategoryButton } from "@/features/admin/delete-category-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Categories · Admin" };

export default async function AdminCategoriesPage() {
  const categories = await adminListCategories();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">Categories</h1>
          <p className="text-sm text-muted-foreground">
            Category → Subcategory → Child category. Create a category first, then create
            another category with it as the parent to nest it.
          </p>
        </div>
        <CategoryFormDialog />
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
        <table className="w-full min-w-170 text-sm">
          <thead className="border-b border-border/70 text-left text-muted-foreground">
            <tr>
              <th className="p-3">Name</th>
              <th className="p-3">Slug</th>
              <th className="p-3">Products</th>
              <th className="p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => (
              <tr key={category.id} className="border-b border-border/50 last:border-0">
                <td className="p-3 font-medium">
                  <span style={{ paddingLeft: `${category.depth * 1.25}rem` }} className="flex items-center gap-1.5">
                    {category.depth > 0 && <span className="text-muted-foreground">↳</span>}
                    {category.name}
                    {category.isFeatured && <Badge variant="secondary" className="ml-1">Featured</Badge>}
                  </span>
                </td>
                <td className="p-3 text-muted-foreground">{category.slug}</td>
                <td className="p-3">{category._count.products}</td>
                <td className="p-3">
                  <Badge variant={category.isActive ? "success" : "secondary"}>
                    {category.isActive ? "Active" : "Disabled"}
                  </Badge>
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <CategoryFormDialog
                      category={category}
                      trigger={<Button size="sm" variant="outline">Edit</Button>}
                    />
                    <DeleteCategoryButton categoryId={category.id} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
