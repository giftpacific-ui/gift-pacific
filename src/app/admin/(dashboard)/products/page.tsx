import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Plus, Pencil } from "lucide-react";
import { adminListProducts } from "@/server/services/admin-product.service";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/shared/pagination";
import { DeleteProductButton } from "@/features/admin/delete-product-button";
import { formatPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "Products · Admin" };

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const { items, total, page, pageCount } = await adminListProducts({
    search: sp.q,
    page: sp.page ? Number(sp.page) : 1,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl">Products ({total})</h1>
        <Button asChild>
          <Link href="/admin/products/new"><Plus /> New product</Link>
        </Button>
      </div>

      <form className="max-w-sm">
        <Input name="q" defaultValue={sp.q} placeholder="Search by name or SKU…" />
      </form>

      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
        <table className="w-full min-w-180 text-sm">
          <thead className="border-b border-border/70 text-left text-muted-foreground">
            <tr>
              <th className="p-3">Product</th>
              <th className="p-3">Category</th>
              <th className="p-3">Price</th>
              <th className="p-3">Stock</th>
              <th className="p-3">Status</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((product) => (
              <tr key={product.id} className="border-b border-border/50 last:border-0 hover:bg-secondary/40">
                <td className="p-3">
                  <Link href={`/admin/products/${product.id}`} className="flex items-center gap-3">
                    <div className="relative size-10 shrink-0 overflow-hidden rounded-md bg-secondary">
                      {product.images[0] && (
                        <Image src={product.images[0].url} alt="" fill className="object-cover" />
                      )}
                    </div>
                    <span className="font-medium hover:underline">{product.name}</span>
                  </Link>
                </td>
                <td className="p-3 text-muted-foreground">{product.category?.name ?? "—"}</td>
                <td className="p-3">{formatPrice(Number(product.price))}</td>
                <td className="p-3">{product.stock}</td>
                <td className="p-3">
                  <Badge variant={product.status === "ACTIVE" ? "success" : "secondary"}>
                    {product.status}
                  </Badge>
                </td>
                <td className="p-3">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      href={`/admin/products/${product.id}`}
                      aria-label={`Edit ${product.name}`}
                      title="Edit product"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="size-4" />
                    </Link>
                    <DeleteProductButton productId={product.id} productName={product.name} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={pageCount} basePath="/admin/products" searchParams={sp} />
    </div>
  );
}
