import type { Metadata } from "next";
import { adminListCoupons } from "@/server/services/admin-coupon.service";
import { CouponFormDialog } from "@/features/admin/coupon-form-dialog";
import { DeleteCouponButton } from "@/features/admin/delete-coupon-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { serializeDecimals } from "@/lib/serialize";

export const metadata: Metadata = { title: "Coupons · Admin" };

export default async function AdminCouponsPage() {
  const coupons = serializeDecimals(await adminListCoupons());

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl">Coupons</h1>
        <CouponFormDialog />
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b border-border/70 text-left text-muted-foreground">
            <tr>
              <th className="p-3">Code</th>
              <th className="p-3">Discount</th>
              <th className="p-3">Usage</th>
              <th className="p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {coupons.map((coupon) => (
              <tr
                key={coupon.id}
                className="border-b border-border/50 last:border-0"
              >
                <td className="p-3 font-medium">{coupon.code}</td>
                <td className="p-3">
                  {coupon.type === "PERCENTAGE"
                    ? `${coupon.value}%`
                    : `$${coupon.value}`}
                </td>
                <td className="p-3 text-muted-foreground">
                  {coupon.usageCount}
                  {coupon.usageLimit ? ` / ${coupon.usageLimit}` : ""}
                </td>
                <td className="p-3">
                  <Badge variant={coupon.isActive ? "success" : "secondary"}>
                    {coupon.isActive ? "Active" : "Inactive"}
                  </Badge>
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <CouponFormDialog
                      coupon={coupon}
                      trigger={
                        <Button size="sm" variant="outline">
                          Edit
                        </Button>
                      }
                    />
                    <DeleteCouponButton couponId={coupon.id} />
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
