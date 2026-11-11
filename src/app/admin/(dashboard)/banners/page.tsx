import type { Metadata } from "next";
import Image from "next/image";
import { adminListBanners } from "@/server/services/admin-banner.service";
import { BannerFormDialog } from "@/features/admin/banner-form-dialog";
import { DeleteBannerButton } from "@/features/admin/delete-banner-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Banners · Admin" };

export default async function AdminBannersPage() {
  const banners = await adminListBanners();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl">Banners</h1>
        <BannerFormDialog />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {banners.map((banner) => (
          <div key={banner.id} className="overflow-hidden rounded-xl border border-border/70 bg-card">
            <div className="relative aspect-video bg-secondary">
              <Image src={banner.imageUrl} alt={banner.title} fill className="object-cover" />
            </div>
            <div className="space-y-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate font-medium">{banner.title}</p>
                <Badge variant={banner.isActive ? "success" : "secondary"} className="shrink-0">
                  {banner.isActive ? "Active" : "Inactive"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{banner.placement.replaceAll("_", " ")}</p>
              <div className="flex items-center gap-3 pt-1">
                <BannerFormDialog banner={banner} trigger={<Button size="sm" variant="outline">Edit</Button>} />
                <DeleteBannerButton bannerId={banner.id} />
              </div>
            </div>
          </div>
        ))}
      </div>
      {banners.length === 0 && <p className="text-sm text-muted-foreground">No banners yet.</p>}
    </div>
  );
}
